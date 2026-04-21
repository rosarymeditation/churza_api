/**
 * chatController.js — REST API for chat operations
 *
 * WHY BOTH REST AND SOCKET.IO?
 *
 * Socket.IO handles real-time text messages perfectly.
 * But files and voice recordings are binary data and need
 * multipart form upload. Socket.IO was not designed for this.
 *
 * So we use REST API for:
 *   - Uploading voice/files to Cloudinary
 *   - Fetching message history when chat opens
 *   - Cell group management (create, update, assign members)
 *
 * Flow for a voice message:
 *   1. Member records voice on phone
 *   2. Flutter uploads to POST /chat/.../upload → Cloudinary
 *   3. Server saves message to MongoDB, returns message object
 *   4. Flutter emits 'message:file' via socket to notify room
 *   5. Room members receive the message instantly
 */

const CellGroup = require('../models/CellGroup');
const ChatMessage = require('../models/ChatMessage');
const Membership = require('../models/Membership');
const cloudinary = require('../config/cloudinary');
const { sendPushNotification } = require('../utils/notifications');
const isAdminOrPastor = async (userId, churchId) => {
    const Membership = require('../models/Membership');
    const m = await Membership.findOne({
        user: userId,
        church: churchId,
        status: 'active',
        role: { $in: ['admin', 'pastor', 'super_admin'] },
    });
    return !!m;
};
const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, code, message) =>
    res.status(code).json({ success: false, message });

// ─────────────────────────────────────────────────────────
// CELL GROUP MANAGEMENT
// ─────────────────────────────────────────────────────────

const createCellGroup = catchAsync(async (req, res) => {
    const { name, description, leaderId, meetingDay, meetingTime, meetingLocation } = req.body;
    if (!name) return errorResponse(res, 400, 'Group name is required');

    const group = await CellGroup.create({
        church: req.params.churchId,
        name: name.trim(),
        description: description?.trim(),
        leader: leaderId || undefined,
        meetingDay,
        meetingTime,
        meetingLocation,
        members: leaderId ? [leaderId] : [],
    });

    await group.populate('leader', 'firstName lastName photoUrl');
    res.status(201).json({ success: true, group });
});

const getCellGroups = catchAsync(async (req, res) => {
    const membership = await Membership.findOne({
        church: req.params.churchId,
        user: req.user._id,
        status: 'active',
    });

    const isAdmin = ['admin', 'pastor'].includes(membership?.role);

    const filter = {
        church: req.params.churchId,
        isActive: true,
        ...(!isAdmin && {
            $or: [
                { members: req.user._id },
                { leader: req.user._id },
            ],
        }),
    };

    const groups = await CellGroup.find(filter)
        .populate('leader', 'firstName lastName photoUrl')
        .sort({ name: 1 })
        .lean();

    // Add unread count badge for each group
    const enriched = await Promise.all(
        groups.map(async (g) => {
            const unread = await ChatMessage.countDocuments({
                cellGroup: g._id,
                readBy: { $ne: req.user._id },
                sender: { $ne: req.user._id },
                isDeleted: false,
            });
            return { ...g, unreadCount: unread };
        })
    );

    res.json({ success: true, groups: enriched });
});

const getCellGroup = catchAsync(async (req, res) => {
    const group = await CellGroup.findOne({
        _id: req.params.groupId,
        church: req.params.churchId,
    })
        .populate('leader', 'firstName lastName photoUrl')
        .populate('members', 'firstName lastName photoUrl');

    if (!group) return errorResponse(res, 404, 'Group not found');
    res.json({ success: true, group });
});

const updateCellGroup = catchAsync(async (req, res) => {
    const allowed = ['name', 'description', 'leader', 'meetingDay', 'meetingTime', 'meetingLocation', 'colour'];
    const updates = {};
    allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const group = await CellGroup.findOneAndUpdate(
        { _id: req.params.groupId, church: req.params.churchId },
        { $set: updates },
        { new: true }
    ).populate('leader', 'firstName lastName photoUrl');

    if (!group) return errorResponse(res, 404, 'Group not found');
    res.json({ success: true, group });
});

const updateGroupMembers = catchAsync(async (req, res) => {
    const { action, memberIds } = req.body;
    if (!['add', 'remove'].includes(action)) {
        return errorResponse(res, 400, 'Action must be add or remove');
    }

    const group = await CellGroup.findOne({ _id: req.params.groupId, church: req.params.churchId });
    if (!group) return errorResponse(res, 404, 'Group not found');

    if (action === 'add') {
        memberIds.forEach((id) => {
            if (!group.members.map(m => m.toString()).includes(id)) {
                group.members.push(id);
            }
        });
        await ChatMessage.create({
            cellGroup: group._id,
            church: group.church,
            sender: req.user._id,
            type: 'system',
            body: `${memberIds.length} member(s) added to the group`,
            readBy: [],
        });
    } else {
        group.members = group.members.filter((m) => !memberIds.includes(m.toString()));
    }

    await group.save();
    res.json({ success: true, group });
});

// ─────────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────────

const getMessages = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;

    const group = await CellGroup.findOne({ _id: req.params.groupId, church: req.params.churchId });
    if (!group) return errorResponse(res, 404, 'Group not found');

    const isMember = group.members.some(
        (m) => m.toString() === req.user._id.toString()
    );
    const isLeader = group.leader?.toString() === req.user._id.toString();
    const isAdmin = await isAdminOrPastor(req.user._id, req.params.churchId);
    if (!isMember && !isLeader && !isAdmin) {
        return errorResponse(res, 403, 'Not authorised');
    }

    const messages = await ChatMessage.find({ cellGroup: req.params.groupId })
        .populate('sender', 'firstName lastName photoUrl')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

    messages.reverse(); // Return in chronological order

    // Mark as read
    const messageIds = messages.map((m) => m._id);
    await ChatMessage.updateMany(
        { _id: { $in: messageIds } },
        { $addToSet: { readBy: req.user._id } }
    );

    const total = await ChatMessage.countDocuments({ cellGroup: req.params.groupId });

    res.json({ success: true, total, page, hasMore: skip + limit < total, messages });
});

const uploadFile = catchAsync(async (req, res) => {
    if (!req.file) return errorResponse(res, 400, 'No file provided');

    const { groupId, churchId } = req.params;
    const isVoice = req.file.mimetype.startsWith('audio/');

    const group = await CellGroup.findOne({ _id: groupId, church: churchId });
    if (!group) return errorResponse(res, 404, 'Group not found');

    const isMember = group.members.some((m) => m.toString() === req.user._id.toString());
    const isLeader = group.leader?.toString() === req.user._id.toString();
    if (!isMember && !isLeader) return errorResponse(res, 403, 'Not a member of this group');

    // Upload to Cloudinary
    const base64 = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
        folder: `churza/${churchId}/chat/${groupId}`,
        resource_type: isVoice ? 'video' : 'auto',
        ...(isVoice && { format: 'mp3', audio_codec: 'mp3', bit_rate: '64k' }),
    });

    // Save message to MongoDB
    const message = await ChatMessage.create({
        cellGroup: groupId,
        church: churchId,
        sender: req.user._id,
        type: isVoice ? 'voice' : 'file',
        fileUrl: result.secure_url,
        fileName: req.file.originalname,
        fileSize: result.bytes,
        fileMimeType: req.file.mimetype,
        fileDuration: isVoice ? Math.round(result.duration || 0) : undefined,
        readBy: [req.user._id],
    });

    await message.populate('sender', 'firstName lastName photoUrl');

    // Notify offline members
    const offlineMembers = group.members
        .filter((m) => m.toString() !== req.user._id.toString())
        .map((m) => m.toString());

    if (offlineMembers.length > 0) {
        await sendPushNotification({
            userIds: offlineMembers,
            title: group.name,
            body: `${req.user.firstName} sent a ${isVoice ? 'voice message' : 'file'}`,
            data: { screen: 'CellChat', cellGroupId: groupId },
        });
    }

    res.status(201).json({ success: true, message });
});

const deleteMessage = catchAsync(async (req, res) => {
    const message = await ChatMessage.findOne({
        _id: req.params.messageId,
        cellGroup: req.params.groupId,
    });
    if (!message) return errorResponse(res, 404, 'Message not found');

    const group = await CellGroup.findById(req.params.groupId);
    const isSender = message.sender.toString() === req.user._id.toString();
    const isLeader = group?.leader?.toString() === req.user._id.toString();

    if (!isSender && !isLeader) return errorResponse(res, 403, 'Cannot delete this message');

    message.isDeleted = true;
    message.deletedAt = new Date();
    message.deletedBy = req.user._id;
    await message.save();

    res.json({ success: true, message: 'Deleted' });
});

module.exports = {
    createCellGroup,
    getCellGroups,
    getCellGroup,
    updateCellGroup,
    updateGroupMembers,
    getMessages,
    uploadFile,
    deleteMessage,
};

// ─────────────────────────────────────────────────────────
// ASSIGN / REMOVE LEADER
// ─────────────────────────────────────────────────────────

/**
 * PATCH /api/chat/churches/:churchId/groups/:groupId/leader
 *
 * Admin assigns or removes a cell leader.
 * Body: { leaderId: '64abc...' } — or { leaderId: null } to remove
 *
 * When assigned, the new leader gets a push notification.
 */
const assignLeader = catchAsync(async (req, res) => {
    const { leaderId } = req.body;

    const group = await CellGroup.findOneAndUpdate(
        { _id: req.params.groupId, church: req.params.churchId },
        { $set: { leader: leaderId || null } },
        { new: true }
    )
        .populate('leader', 'firstName lastName photoUrl')
        .populate('members', 'firstName lastName photoUrl');

    if (!group) return errorResponse(res, 404, 'Group not found');

    // Notify the new leader via push notification
    if (leaderId) {
        await sendPushNotification({
            userIds: [leaderId],
            title: 'Cell Group Leadership',
            body: `You have been appointed as leader of ${group.name}`,
            data: { screen: 'CellGroups' },
        });

        // Post a system message in the group chat
        await ChatMessage.create({
            cellGroup: group._id,
            church: group.church,
            sender: req.user._id,
            type: 'system',
            body: `${group.leader?.firstName || 'A member'} has been appointed as group leader`,
            readBy: [],
        });
    }

    res.json({ success: true, group });
});

/**
 * PATCH /api/chat/churches/:churchId/groups/:groupId/members
 *
 * Updated version with push notifications when adding members.
 * Overrides the existing updateGroupMembers.
 */
const updateGroupMembersWithNotification = catchAsync(async (req, res) => {
    const { action, memberIds } = req.body;

    if (!['add', 'remove'].includes(action)) {
        return errorResponse(res, 400, 'Action must be add or remove');
    }

    const group = await CellGroup.findOne({
        _id: req.params.groupId,
        church: req.params.churchId,
    });
    if (!group) return errorResponse(res, 404, 'Group not found');

    if (action === 'add') {
        // Add new members (avoid duplicates)
        memberIds.forEach((id) => {
            if (!group.members.map(m => m.toString()).includes(id)) {
                group.members.push(id);
            }
        });

        // Notify added members
        await sendPushNotification({
            userIds: memberIds,
            title: `Welcome to ${group.name}`,
            body: `You have been added to ${group.name} cell group. Tap to say hello!`,
            data: { screen: 'CellChat', cellGroupId: group._id.toString() },
        });

        // System message in chat
        await ChatMessage.create({
            cellGroup: group._id,
            church: group.church,
            sender: req.user._id,
            type: 'system',
            body: `${memberIds.length} member${memberIds.length > 1 ? 's' : ''} added to the group`,
            readBy: [],
        });

    } else {
        // Remove members
        group.members = group.members.filter(
            (m) => !memberIds.includes(m.toString())
        );

        // System message
        await ChatMessage.create({
            cellGroup: group._id,
            church: group.church,
            sender: req.user._id,
            type: 'system',
            body: `${memberIds.length} member${memberIds.length > 1 ? 's' : ''} removed from the group`,
            readBy: [],
        });
    }

    await group.save();
    await group.populate('leader', 'firstName lastName photoUrl');
    await group.populate('members', 'firstName lastName photoUrl');

    res.json({ success: true, group });
});

module.exports = {
    ...module.exports,
    assignLeader,
    updateGroupMembersWithNotification,
};