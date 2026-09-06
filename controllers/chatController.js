
const CellGroup = require("../models/CellGroup");
const ChatMessage = require("../models/ChatMessage");
const Membership = require("../models/Membership");
const cloudinary = require("../config/cloudinary");
const { sendPushNotification } = require("../utils/notifications");

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, code, message) =>
    res.status(code).send({ error: true, message });

const isAdminOrPastor = async (userId, churchId) => {
    const m = await Membership.findOne({
        user: userId,
        church: churchId,
        status: "active",
        role: { $in: ["admin", "pastor", "super_admin"] },
    });
    return !!m;
};

module.exports = {
    // ── cell group management ──────────────────────────────
    createCellGroup: catchAsync(async (req, res) => {
        const { name, description, leaderId, meetingDay, meetingTime, meetingLocation } = req.body;
        if (!name) return errorResponse(res, 400, "Group name is required");

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

        await group.populate("leader", "firstName lastName photoUrl");
        return res.status(201).send({ error: false, data: group });
    }),

    getCellGroups: catchAsync(async (req, res) => {
        const membership = await Membership.findOne({
            church: req.params.churchId,
            user: req.user._id,
            status: "active",
        });

        const isAdmin = ["admin", "pastor"].includes(membership?.role);

        const filter = {
            church: req.params.churchId,
            isActive: true,
            ...(!isAdmin && {
                $or: [{ members: req.user._id }, { leader: req.user._id }],
            }),
        };

        const groups = await CellGroup.find(filter)
            .populate("leader", "firstName lastName photoUrl")
            .sort({ name: 1 })
            .lean();

        // tack on an unread badge count per group
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

        // used res.json here instead of send, both work fine, just didnt clean up
        return res.json({ error: false, data: enriched });
    }),

    getCellGroup: catchAsync(async (req, res) => {
        const group = await CellGroup.findOne({
            _id: req.params.groupId,
            church: req.params.churchId,
        })
            .populate("leader", "firstName lastName photoUrl")
            .populate("members", "firstName lastName photoUrl");

        if (!group) return errorResponse(res, 404, "Group not found");
        return res.send({ error: false, data: group });
    }),

    updateCellGroup: catchAsync(async (req, res) => {
        const allowed = ["name", "description", "leader", "meetingDay", "meetingTime", "meetingLocation", "colour"];
        const updates = {};
        allowed.forEach((f) => {
            if (req.body[f] !== undefined) updates[f] = req.body[f];
        });

        const group = await CellGroup.findOneAndUpdate(
            { _id: req.params.groupId, church: req.params.churchId },
            { $set: updates },
            { new: true }
        ).populate("leader", "firstName lastName photoUrl");

        if (!group) return errorResponse(res, 404, "Group not found");
        return res.send({ error: false, data: group });
    }),

    updateGroupMembers: catchAsync(async (req, res) => {
        const { action, memberIds } = req.body;
        if (!["add", "remove"].includes(action)) {
            return errorResponse(res, 400, "Action must be add or remove");
        }

        const group = await CellGroup.findOne({ _id: req.params.groupId, church: req.params.churchId });
        if (!group) return errorResponse(res, 404, "Group not found");

        if (action === "add") {
            memberIds.forEach((id) => {
                if (!group.members.map((m) => m.toString()).includes(id)) {
                    group.members.push(id);
                }
            });
            await ChatMessage.create({
                cellGroup: group._id,
                church: group.church,
                sender: req.user._id,
                type: "system",
                body: `${memberIds.length} member(s) added to the group`,
                readBy: [],
            });
        } else {
            group.members = group.members.filter((m) => !memberIds.includes(m.toString()));
        }

        await group.save();
        return res.send({ error: false, data: group });
    }),

    // ── messages ─────────────────────────────────────────────
    getMessages: catchAsync(async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 50);
        const skip = (page - 1) * limit;

        const group = await CellGroup.findOne({ _id: req.params.groupId, church: req.params.churchId });
        if (!group) return errorResponse(res, 404, "Group not found");

        const isMember = group.members.some((m) => m.toString() === req.user._id.toString());
        const isLeader = group.leader?.toString() === req.user._id.toString();
        const isAdmin = await isAdminOrPastor(req.user._id, req.params.churchId);
        if (!isMember && !isLeader && !isAdmin) {
            return errorResponse(res, 403, "Not authorised");
        }

        const messages = await ChatMessage.find({ cellGroup: req.params.groupId })
            .populate("sender", "firstName lastName photoUrl")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        messages.reverse(); // chronological order for the UI

        const messageIds = messages.map((m) => m._id);
        await ChatMessage.updateMany(
            { _id: { $in: messageIds } },
            { $addToSet: { readBy: req.user._id } }
        );

        const total = await ChatMessage.countDocuments({ cellGroup: req.params.groupId });

        return res.send({
            error: false,
            total,
            page,
            hasMore: skip + limit < total,
            data: messages,
        });
    }),

    uploadFile: catchAsync(async (req, res) => {
        if (!req.file) return errorResponse(res, 400, "No file provided");

        const { groupId, churchId } = req.params;
        const isVoice = req.file.mimetype.startsWith("audio/");

        const group = await CellGroup.findOne({ _id: groupId, church: churchId });
        if (!group) return errorResponse(res, 404, "Group not found");

        const isMember = group.members.some((m) => m.toString() === req.user._id.toString());
        const isLeader = group.leader?.toString() === req.user._id.toString();
        if (!isMember && !isLeader) return errorResponse(res, 403, "Not a member of this group");

        const base64 = req.file.buffer.toString("base64");
        const dataUri = `data:${req.file.mimetype};base64,${base64}`;

        const result = await cloudinary.uploader.upload(dataUri, {
            folder: `churza/${churchId}/chat/${groupId}`,
            resource_type: isVoice ? "video" : "auto",
            ...(isVoice && { format: "mp3", audio_codec: "mp3", bit_rate: "64k" }),
        });

        const message = await ChatMessage.create({
            cellGroup: groupId,
            church: churchId,
            sender: req.user._id,
            type: isVoice ? "voice" : "file",
            fileUrl: result.secure_url,
            fileName: req.file.originalname,
            fileSize: result.bytes,
            fileMimeType: req.file.mimetype,
            fileDuration: isVoice ? Math.round(result.duration || 0) : undefined,
            readBy: [req.user._id],
        });

        await message.populate("sender", "firstName lastName photoUrl");

        // ping everyone else in the group who isnt the sender
        const offlineMembers = group.members
            .filter((m) => m.toString() !== req.user._id.toString())
            .map((m) => m.toString());

        if (offlineMembers.length > 0) {
            await sendPushNotification({
                userIds: offlineMembers,
                title: group.name,
                body: `${req.user.firstName} sent a ${isVoice ? "voice message" : "file"}`,
                data: { screen: "CellChat", cellGroupId: groupId },
            });
        }

        return res.status(201).send({ error: false, data: message });
    }),

    deleteMessage: catchAsync(async (req, res) => {
        const message = await ChatMessage.findOne({
            _id: req.params.messageId,
            cellGroup: req.params.groupId,
        });
        if (!message) return errorResponse(res, 404, "Message not found");

        const group = await CellGroup.findById(req.params.groupId);
        const isSender = message.sender.toString() === req.user._id.toString();
        const isLeader = group?.leader?.toString() === req.user._id.toString();

        if (!isSender && !isLeader) return errorResponse(res, 403, "Cannot delete this message");

        message.isDeleted = true;
        message.deletedAt = new Date();
        message.deletedBy = req.user._id;
        await message.save();

        return res.send({ error: false, message: "Deleted" });
    }),

    // ── assign / remove leader ──────────────────────────────
    // admin assigns or clears a cell leader (leaderId: null to remove)
    assignLeader: catchAsync(async (req, res) => {
        const { leaderId } = req.body;

        const group = await CellGroup.findOneAndUpdate(
            { _id: req.params.groupId, church: req.params.churchId },
            { $set: { leader: leaderId || null } },
            { new: true }
        )
            .populate("leader", "firstName lastName photoUrl")
            .populate("members", "firstName lastName photoUrl");

        if (!group) return errorResponse(res, 404, "Group not found");

        if (leaderId) {
            await sendPushNotification({
                userIds: [leaderId],
                title: "Cell Group Leadership",
                body: `You have been appointed as leader of ${group.name}`,
                data: { screen: "CellGroups" },
            });

            await ChatMessage.create({
                cellGroup: group._id,
                church: group.church,
                sender: req.user._id,
                type: "system",
                body: `${group.leader?.firstName || "A member"} has been appointed as group leader`,
                readBy: [],
            });
        }

        return res.send({ error: false, data: group });
    }),

    // NOTE: not currently wired up in chatRoutes.js — the route file only
    // calls updateGroupMembers above. Keeping this here since it existed
    // in the original, but it's dead code until a route actually points
    // to it (or updateGroupMembers gets replaced with this version).
    updateGroupMembersWithNotification: catchAsync(async (req, res) => {
        const { action, memberIds } = req.body;

        if (!["add", "remove"].includes(action)) {
            return errorResponse(res, 400, "Action must be add or remove");
        }

        const group = await CellGroup.findOne({
            _id: req.params.groupId,
            church: req.params.churchId,
        });
        if (!group) return errorResponse(res, 404, "Group not found");

        if (action === "add") {
            memberIds.forEach((id) => {
                if (!group.members.map((m) => m.toString()).includes(id)) {
                    group.members.push(id);
                }
            });

            await sendPushNotification({
                userIds: memberIds,
                title: `Welcome to ${group.name}`,
                body: `You have been added to ${group.name} cell group. Tap to say hello!`,
                data: { screen: "CellChat", cellGroupId: group._id.toString() },
            });

            await ChatMessage.create({
                cellGroup: group._id,
                church: group.church,
                sender: req.user._id,
                type: "system",
                body: `${memberIds.length} member${memberIds.length > 1 ? "s" : ""} added to the group`,
                readBy: [],
            });
        } else {
            group.members = group.members.filter((m) => !memberIds.includes(m.toString()));

            await ChatMessage.create({
                cellGroup: group._id,
                church: group.church,
                sender: req.user._id,
                type: "system",
                body: `${memberIds.length} member${memberIds.length > 1 ? "s" : ""} removed from the group`,
                readBy: [],
            });
        }

        await group.save();
        await group.populate("leader", "firstName lastName photoUrl");
        await group.populate("members", "firstName lastName photoUrl");

        return res.send({ error: false, data: group });
    }),
};