const crypto = require('crypto');
const Church = require('../models/Church');
const PrayerRequest = require('../models/PrayerRequest');
const Membership = require('../models/Membership');
const Notification = require('../models/Notification');
const Announcement = require('../models/Announcement');
const Event = require('../models/Event');
const User = require('../models/User');
const { sendEmail } = require('../utils/email');
const Sermon = require('../models/Sermon');
const cloudinary = require('../config/cloudinary');
const {
  notifyMembershipApproved,
  notifyNewMemberRequest,
  notifyNewSermon,
  notifyNewAnnouncement,
  notifyNewEvent,
  notifyPrayerReceived,
} = require('../utils/churchNotifications');

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const generateUniqueCode = async () => {
  let code;
  let exists = true;
  while (exists) {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
    exists = await Church.exists({ code });
  }
  return code;
};

// ─────────────────────────────────────────────────────────
// Church CRUD
// ─────────────────────────────────────────────────────────

const createChurch = catchAsync(async (req, res) => {
  const { name, description, contact, address, serviceSchedule } = req.body;

  if (!name) return errorResponse(res, 400, 'Church name is required');

  const code = await generateUniqueCode();

  const church = await Church.create({
    name,
    description,
    contact,
    address,
    serviceSchedule,
    code,
    subscription: {
      plan: 'starter',
      status: 'trial',
      trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  await Membership.create({
    user: req.user._id,
    church: church._id,
    role: 'admin',
    status: 'active',
    approvedAt: new Date(),
    approvedBy: req.user._id,
    joinedAt: new Date(),
  });

  res.status(201).json({ success: true, church });
});

const getChurch = catchAsync(async (req, res) => {
  const church = await Church.findById(req.params.churchId).lean();
  if (!church) return errorResponse(res, 404, 'Church not found');
  res.status(200).json({ success: true, church });
});

const updateChurch = catchAsync(async (req, res) => {
  const blocked = ['code', 'subscription', 'memberCount'];
  blocked.forEach((f) => delete req.body[f]);

  const church = await Church.findByIdAndUpdate(
    req.params.churchId,
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!church) return errorResponse(res, 404, 'Church not found');
  res.status(200).json({ success: true, church });
});

const deleteChurch = catchAsync(async (req, res) => {
  const church = await Church.findByIdAndUpdate(
    req.params.churchId,
    { isActive: false },
    { new: true }
  );
  if (!church) return errorResponse(res, 404, 'Church not found');
  res.status(200).json({ success: true, message: 'Church deactivated' });
});

// ─────────────────────────────────────────────────────────
// Sermons
// ─────────────────────────────────────────────────────────

const createSermon = catchAsync(async (req, res) => {
  const { churchId } = req.params;
  const {
    title, speaker, description, seriesName,
    videoUrl, tags, bibleReferences, status, publishedAt,
  } = req.body;

  if (!title) return errorResponse(res, 400, 'Sermon title is required');

  let audioUrl = null;
  let durationSeconds = null;
  let fileSize = null;
  let mimeType = null;
  let finalMediaType = 'link';

  if (req.file) {
    const base64 = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      resource_type: 'video',
      folder: `churza/${churchId}/sermons`,
      format: 'mp3',
      audio_codec: 'mp3',
      bit_rate: '128k',
    });

    audioUrl = result.secure_url;
    durationSeconds = result.duration ? Math.round(result.duration) : null;
    fileSize = result.bytes;
    mimeType = req.file.mimetype;
    finalMediaType = 'audio';

  } else if (videoUrl) {
    finalMediaType = 'link';
  } else {
    return errorResponse(res, 400, 'Provide either an audio file or a video URL');
  }

  const parseList = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter(Boolean);
    return val.split(',').map((t) => t.trim()).filter(Boolean);
  };

  const sermon = await Sermon.create({
    church: churchId,
    uploadedBy: req.user._id,
    title,
    speaker: speaker || undefined,
    description: description || undefined,
    seriesName: seriesName || undefined,
    mediaType: finalMediaType,
    audioUrl,
    videoUrl: videoUrl || undefined,
    durationSeconds,
    fileSize,
    mimeType,
    tags: parseList(tags),
    bibleReferences: parseList(bibleReferences),
    status: status || 'published',
    publishedAt: status === 'published'
      ? (publishedAt ? new Date(publishedAt) : new Date())
      : undefined,
  });

  // ── Push notification — only for published sermons ────
  if ((status || 'published') === 'published') {
    notifyNewSermon({
      churchId: churchId,
      title: sermon.title,
      speaker: sermon.speaker,
    });
  }

  res.status(201).json({ success: true, sermon });
});

const getSermons = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const filter = { church: req.params.churchId };
  if (req.query.status) filter.status = req.query.status;

  let sermons = await Sermon.find(filter)
    .populate('uploadedBy', 'firstName lastName')
    .sort({ publishedAt: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  if (req.query.search) {
    const term = req.query.search.toLowerCase();
    sermons = sermons.filter(
      (s) =>
        s.title?.toLowerCase().includes(term) ||
        s.speaker?.toLowerCase().includes(term) ||
        s.seriesName?.toLowerCase().includes(term) ||
        s.tags?.some((t) => t.includes(term))
    );
  }

  const total = await Sermon.countDocuments(filter);
  res.status(200).json({ success: true, total, page, sermons });
});

const getSermon = catchAsync(async (req, res) => {
  const sermon = await Sermon.findOne({
    _id: req.params.sermonId,
    church: req.params.churchId,
  }).populate('uploadedBy', 'firstName lastName');

  if (!sermon) return errorResponse(res, 404, 'Sermon not found');

  await Sermon.findByIdAndUpdate(sermon._id, { $inc: { views: 1 } });
  res.status(200).json({ success: true, sermon });
});

const updateSermon = catchAsync(async (req, res) => {
  const blocked = ['church', 'uploadedBy', 'audioUrl', 'fileSize', 'mimeType', 'views', 'downloads'];
  blocked.forEach((f) => delete req.body[f]);

  const sermon = await Sermon.findOneAndUpdate(
    { _id: req.params.sermonId, church: req.params.churchId },
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!sermon) return errorResponse(res, 404, 'Sermon not found');
  res.status(200).json({ success: true, sermon });
});

const deleteSermon = catchAsync(async (req, res) => {
  const sermon = await Sermon.findOne({
    _id: req.params.sermonId,
    church: req.params.churchId,
  });

  if (!sermon) return errorResponse(res, 404, 'Sermon not found');

  if (sermon.audioUrl && sermon.audioUrl.includes('cloudinary')) {
    try {
      const parts = sermon.audioUrl.split('/');
      const file = parts[parts.length - 1].split('.')[0];
      const folder = `churza/${sermon.church}/sermons`;
      const publicId = `${folder}/${file}`;
      await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
    } catch (e) {
      console.error('Cloudinary delete failed:', e.message);
    }
  }

  await sermon.deleteOne();
  res.status(200).json({ success: true, message: 'Sermon deleted' });
});

// ─────────────────────────────────────────────────────────
// Join by code
// ─────────────────────────────────────────────────────────

const joinByCode = catchAsync(async (req, res) => {
  const { code } = req.body;

  if (!code) return errorResponse(res, 400, 'Church code is required');

  const church = await Church.findOne({
    code: code.toUpperCase().trim(),
    isActive: true,
  });

  if (!church) return errorResponse(res, 404, 'No active church found with that code');

  const existing = await Membership.findOne({
    user: req.user._id,
    church: church._id,
  });

  if (existing) {
    if (existing.status === 'active') {
      return errorResponse(res, 409, 'You are already an active member of this church');
    }
    if (existing.status === 'pending') {
      return errorResponse(res, 409, 'Your membership request is already pending approval');
    }

    // Re-activate a previously inactive membership
    existing.status = church.settings.requireApproval ? 'pending' : 'active';
    if (!church.settings.requireApproval) {
      existing.approvedAt = new Date();
      existing.joinedAt = new Date();
    }
    await existing.save();

    // ── Notify admins of the re-activation request ────
    if (existing.status === 'pending') {
      notifyNewMemberRequest({
        churchId: church._id.toString(),
        memberName: `${req.user.firstName} ${req.user.lastName}`,
        membershipId: existing._id.toString(),
      });
    }

    return res.status(200).json({ success: true, membership: existing, church });
  }

  const autoApprove = !church.settings.requireApproval;

  const membership = await Membership.create({
    user: req.user._id,
    church: church._id,
    role: 'member',
    status: autoApprove ? 'active' : 'pending',
    joinedAt: autoApprove ? new Date() : undefined,
    approvedAt: autoApprove ? new Date() : undefined,
  });

  if (autoApprove) {
    await Church.findByIdAndUpdate(church._id, { $inc: { memberCount: 1 } });
  }

  // ── In-app notification to admins ────────────────────
  const admins = await Membership.find({
    church: church._id,
    role: { $in: ['admin', 'pastor'] },
    status: 'active',
  }).select('user');

  if (admins.length) {
    await Notification.insertMany(
      admins.map((a) => ({
        user: a.user,
        church: church._id,
        type: 'member_joined',
        title: 'New member request',
        body: `${req.user.firstName} ${req.user.lastName} wants to join ${church.name}`,
        data: { screen: 'MemberDetail', membershipId: membership._id },
      }))
    );
  }

  // ── Push notification to admins ───────────────────────
  // Only send push when approval is required (pending state)
  // If auto-approved there is no action needed from admin
  if (!autoApprove) {
    notifyNewMemberRequest({
      churchId: church._id.toString(),
      memberName: `${req.user.firstName} ${req.user.lastName}`,
      membershipId: membership._id.toString(),
    });
  }

  res.status(201).json({
    success: true,
    membership,
    church: {
      _id: church._id,
      name: church.name,
      code: church.code,
      logoUrl: church.logoUrl,
    },
    message: autoApprove
      ? 'Welcome! You are now a member.'
      : 'Request sent. Awaiting admin approval.',
  });
});

// ─────────────────────────────────────────────────────────
// Member management
// ─────────────────────────────────────────────────────────

const getMembers = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const filter = { church: req.params.churchId };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.role) filter.role = req.query.role;
  if (req.query.cellGroup) filter.cellGroup = req.query.cellGroup;
  if (req.query.isFlagged !== undefined) {
    filter.isFlagged = req.query.isFlagged === 'true';
  }

  let memberships = await Membership.find(filter)
    .populate('user', 'firstName lastName email phone photoUrl')
    .populate('cellGroup', 'name')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  if (req.query.search) {
    const term = req.query.search.toLowerCase();
    memberships = memberships.filter((m) => {
      const u = m.user;
      return (
        u?.firstName?.toLowerCase().includes(term) ||
        u?.lastName?.toLowerCase().includes(term) ||
        u?.email?.toLowerCase().includes(term)
      );
    });
  }

  const total = await Membership.countDocuments(filter);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    members: memberships,
  });
});

const getMember = catchAsync(async (req, res) => {
  const membership = await Membership.findOne({
    _id: req.params.membershipId,
    church: req.params.churchId,
  })
    .populate('user', '-passwordHash -emailVerificationToken -passwordResetToken -passwordResetExpiresAt')
    .populate('cellGroup', 'name meetingDay meetingTime')
    .populate('approvedBy', 'firstName lastName');

  if (!membership) return errorResponse(res, 404, 'Member not found');
  res.status(200).json({ success: true, membership });
});

const approveMember = catchAsync(async (req, res) => {
  const membership = await Membership.findOne({
    _id: req.params.membershipId,
    church: req.params.churchId,
    status: 'pending',
  }).populate('user', 'firstName lastName');

  if (!membership) return errorResponse(res, 404, 'Pending membership not found');

  membership.status = 'active';
  membership.approvedAt = new Date();
  membership.approvedBy = req.user._id;
  membership.joinedAt = new Date();
  await membership.save();

  await Church.findByIdAndUpdate(req.params.churchId, { $inc: { memberCount: 1 } });

  // ── In-app notification ───────────────────────────────
  await Notification.create({
    user: membership.user._id,
    church: req.params.churchId,
    type: 'membership_approved',
    title: 'Membership approved!',
    body: 'Welcome! Your membership request has been approved.',
    data: { screen: 'Home' },
  });

  // ── Push notification to the member ──────────────────
  const church = await Church.findById(req.params.churchId).select('name').lean();
  notifyMembershipApproved({
    membership,
    church: { name: church?.name ?? 'your church' },
  });

  res.status(200).json({ success: true, membership });
});

const updateMember = catchAsync(async (req, res) => {
  const allowed = [
    'role', 'cellGroup', 'department', 'milestones',
    'notes', 'membershipNumber', 'emergencyContact',
  ];
  const updates = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  if (Object.keys(updates).length === 0) {
    return errorResponse(res, 400, 'No valid fields provided');
  }

  const membership = await Membership.findOneAndUpdate(
    { _id: req.params.membershipId, church: req.params.churchId },
    { $set: updates },
    { new: true, runValidators: true }
  ).populate('user', 'firstName lastName email photoUrl');

  if (!membership) return errorResponse(res, 404, 'Member not found');
  res.status(200).json({ success: true, membership });
});

const setMemberStatus = catchAsync(async (req, res) => {
  const { status } = req.body;
  const allowed = ['active', 'inactive', 'suspended'];

  if (!allowed.includes(status)) {
    return errorResponse(res, 400, `status must be one of: ${allowed.join(', ')}`);
  }

  const membership = await Membership.findOneAndUpdate(
    { _id: req.params.membershipId, church: req.params.churchId },
    { status },
    { new: true }
  );

  if (!membership) return errorResponse(res, 404, 'Member not found');
  res.status(200).json({ success: true, membership });
});

const getFlaggedMembers = catchAsync(async (req, res) => {
  const flagged = await Membership.find({
    church: req.params.churchId,
    isFlagged: true,
    status: 'active',
  })
    .populate('user', 'firstName lastName phone photoUrl')
    .populate('cellGroup', 'name')
    .sort({ flaggedAt: -1 })
    .lean();

  res.status(200).json({ success: true, total: flagged.length, members: flagged });
});

const getDashboard = catchAsync(async (req, res) => {
  const churchId = req.params.churchId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalMembers, newThisMonth, pendingApprovals, flaggedCount] =
    await Promise.all([
      Membership.countDocuments({ church: churchId, status: 'active' }),
      Membership.countDocuments({ church: churchId, status: 'active', joinedAt: { $gte: startOfMonth } }),
      Membership.countDocuments({ church: churchId, status: 'pending' }),
      Membership.countDocuments({ church: churchId, isFlagged: true, status: 'active' }),
    ]);

  res.status(200).json({
    success: true,
    dashboard: { totalMembers, newThisMonth, pendingApprovals, flaggedCount },
  });
});

// ─────────────────────────────────────────────────────────
// Prayer
// ─────────────────────────────────────────────────────────

const createPrayerRequest = catchAsync(async (req, res) => {
  const { title, body, category, isAnonymous, isPublic } = req.body;
  if (!title) return errorResponse(res, 400, 'Prayer title is required');

  const prayer = await PrayerRequest.create({
    church: req.params.churchId,
    user: req.user._id,
    title: title.trim(),
    body: body?.trim() || undefined,
    category: category || 'general',
    isAnonymous: isAnonymous === true,
    isPublic: isPublic !== false,
    status: 'open',
    prayerCount: 0,
    prayedBy: [],
  });

  await prayer.populate('user', 'firstName lastName photoUrl');
  const response = prayer.toObject();
  response.hasPrayed = false;

  res.status(201).json({ success: true, prayer: response });
});

const getPrayerRequests = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const filter = { church: req.params.churchId, isPublic: true };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;

  const prayers = await PrayerRequest.find(filter)
    .populate('user', 'firstName lastName photoUrl')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const userId = req.user._id.toString();
  const enriched = prayers.map((p) => ({
    ...p,
    hasPrayed: p.prayedBy?.some((id) => id.toString() === userId) || false,
  }));

  const total = await PrayerRequest.countDocuments(filter);
  res.status(200).json({ success: true, total, page, prayers: enriched });
});

const getPrayerRequest = catchAsync(async (req, res) => {
  const prayer = await PrayerRequest.findOne({
    _id: req.params.pid,
    church: req.params.churchId,
  }).populate('user', 'firstName lastName photoUrl').lean();

  if (!prayer) return errorResponse(res, 404, 'Prayer request not found');

  const userId = req.user._id.toString();
  prayer.hasPrayed = prayer.prayedBy?.some((id) => id.toString() === userId) || false;

  res.status(200).json({ success: true, prayer });
});

const prayForRequest = catchAsync(async (req, res) => {
  const prayer = await PrayerRequest.findOne({
    _id: req.params.pid,
    church: req.params.churchId,
    status: 'open',
  });

  if (!prayer) return errorResponse(res, 404, 'Prayer request not found');

  const userId = req.user._id.toString();
  const alreadyPrayed = prayer.prayedBy.some((id) => id.toString() === userId);

  if (alreadyPrayed) {
    return errorResponse(res, 409, 'You have already prayed for this');
  }

  prayer.prayedBy.push(req.user._id);
  prayer.prayerCount = prayer.prayedBy.length;
  await prayer.save();
  await prayer.populate('user', 'firstName lastName photoUrl');

  // ── Push notification at milestone prayer counts ──────
  // Fires at 1, 5, 10, 25, 50 — not on every single prayer
  notifyPrayerReceived({
    request: prayer,
    prayerCount: prayer.prayerCount,
  });

  const response = prayer.toObject();
  response.hasPrayed = true;

  res.status(200).json({ success: true, prayer: response });
});

const markAnswered = catchAsync(async (req, res) => {
  const prayer = await PrayerRequest.findOne({
    _id: req.params.pid,
    church: req.params.churchId,
    user: req.user._id,
  });

  if (!prayer) return errorResponse(res, 404, 'Prayer not found or not yours');

  prayer.status = 'answered';
  prayer.answeredAt = new Date();
  if (req.body.testimony) prayer.testimony = req.body.testimony.trim();
  await prayer.save();
  await prayer.populate('user', 'firstName lastName photoUrl');

  const response = prayer.toObject();
  const userId = req.user._id.toString();
  response.hasPrayed = prayer.prayedBy.some((id) => id.toString() === userId);

  res.status(200).json({ success: true, prayer: response });
});

const deletePrayerRequest = catchAsync(async (req, res) => {
  const prayer = await PrayerRequest.findOne({
    _id: req.params.pid,
    church: req.params.churchId,
  });

  if (!prayer) return errorResponse(res, 404, 'Prayer request not found');

  const isOwner = prayer.user.toString() === req.user._id.toString();
  const isAdmin = ['admin', 'pastor'].includes(req.membership?.role);

  if (!isOwner && !isAdmin) {
    return errorResponse(res, 403, 'You cannot delete this prayer request');
  }

  await prayer.deleteOne();
  res.status(200).json({ success: true, message: 'Deleted' });
});

// ─────────────────────────────────────────────────────────
// Announcements
// ─────────────────────────────────────────────────────────

const createAnnouncement = catchAsync(async (req, res) => {
  const { title, body, audience, isPinned, expiresAt, imageUrl } = req.body;

  if (!title) return errorResponse(res, 400, 'Title is required');
  if (!body) return errorResponse(res, 400, 'Message body is required');

  const announcement = await Announcement.create({
    church: req.params.churchId,
    author: req.user._id,
    title: title.trim(),
    body: body.trim(),
    audience: audience || 'all',
    isPinned: isPinned === true,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    imageUrl: imageUrl || undefined,
  });

  await announcement.populate('author', 'firstName lastName');

  // ── Push notification to all members (or leaders only) ─
  notifyNewAnnouncement({
    churchId: req.params.churchId,
    title: announcement.title,
    body: announcement.body,
    audience: announcement.audience || 'all',
  });

  res.status(201).json({ success: true, announcement });
});

const getAnnouncements = catchAsync(async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit) || 30);

  const announcements = await Announcement.find({
    church: req.params.churchId,
  })
    .populate('author', 'firstName lastName')
    .sort({ isPinned: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  res.status(200).json({ success: true, announcements });
});

const getAnnouncement = catchAsync(async (req, res) => {
  const announcement = await Announcement.findOne({
    _id: req.params.aid,
    church: req.params.churchId,
  }).populate('author', 'firstName lastName');

  if (!announcement) return errorResponse(res, 404, 'Announcement not found');
  res.status(200).json({ success: true, announcement });
});

const updateAnnouncement = catchAsync(async (req, res) => {
  const allowed = ['title', 'body', 'audience', 'isPinned', 'expiresAt', 'imageUrl'];
  const updates = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  const announcement = await Announcement.findOneAndUpdate(
    { _id: req.params.aid, church: req.params.churchId },
    { $set: updates },
    { new: true, runValidators: true }
  ).populate('author', 'firstName lastName');

  if (!announcement) return errorResponse(res, 404, 'Announcement not found');
  res.status(200).json({ success: true, announcement });
});

const deleteAnnouncement = catchAsync(async (req, res) => {
  const announcement = await Announcement.findOneAndDelete({
    _id: req.params.aid,
    church: req.params.churchId,
  });

  if (!announcement) return errorResponse(res, 404, 'Announcement not found');
  res.status(200).json({ success: true, message: 'Announcement deleted' });
});

// ─────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────

const createEvent = catchAsync(async (req, res) => {
  const { title, description, location, startsAt, endsAt, imageUrl, isPublic } = req.body;

  if (!title) return errorResponse(res, 400, 'Title is required');
  if (!startsAt) return errorResponse(res, 400, 'Start date is required');

  const event = await Event.create({
    church: req.params.churchId,
    organiser: req.user._id,
    title: title.trim(),
    description: description?.trim(),
    location: location?.trim(),
    startsAt: new Date(startsAt),
    endsAt: endsAt ? new Date(endsAt) : undefined,
    imageUrl,
    isPublic: isPublic !== false,
    status: 'upcoming',
    rsvpList: [],
    rsvpCount: 0,
  });

  await event.populate('organiser', 'firstName lastName');

  // ── Push notification to all members ─────────────────
  notifyNewEvent({
    churchId: req.params.churchId,
    title: event.title,
    startsAt: event.startsAt,
    eventId: event._id.toString(),
  });

  res.status(201).json({ success: true, event });
});

const getEvents = catchAsync(async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const filter = { church: req.params.churchId };
  if (req.query.status) filter.status = req.query.status;

  const userId = req.user._id.toString();

  const events = await Event.find(filter)
    .populate('organiser', 'firstName lastName')
    .sort({ startsAt: 1 })
    .limit(limit)
    .lean();

  const enriched = events.map((e) => ({
    ...e,
    hasRsvped: e.rsvpList?.some((id) => id.toString() === userId) || false,
  }));

  res.status(200).json({ success: true, events: enriched });
});

const getEvent = catchAsync(async (req, res) => {
  const userId = req.user._id.toString();
  const event = await Event.findOne({
    _id: req.params.eid,
    church: req.params.churchId,
  }).populate('organiser', 'firstName lastName').lean();

  if (!event) return errorResponse(res, 404, 'Event not found');

  event.hasRsvped = event.rsvpList?.some((id) => id.toString() === userId) || false;
  res.status(200).json({ success: true, event });
});

const updateEvent = catchAsync(async (req, res) => {
  const allowed = ['title', 'description', 'location', 'startsAt', 'endsAt', 'imageUrl', 'isPublic'];
  const updates = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  const event = await Event.findOneAndUpdate(
    { _id: req.params.eid, church: req.params.churchId },
    { $set: updates },
    { new: true, runValidators: true }
  ).populate('organiser', 'firstName lastName');

  if (!event) return errorResponse(res, 404, 'Event not found');
  res.status(200).json({ success: true, event });
});

const cancelEvent = catchAsync(async (req, res) => {
  const event = await Event.findOneAndUpdate(
    { _id: req.params.eid, church: req.params.churchId },
    {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancellationNote: req.body.note || undefined,
    },
    { new: true }
  ).populate('organiser', 'firstName lastName');

  if (!event) return errorResponse(res, 404, 'Event not found');
  res.status(200).json({ success: true, event });
});

const rsvp = catchAsync(async (req, res) => {
  const event = await Event.findOne({
    _id: req.params.eid,
    church: req.params.churchId,
    status: 'upcoming',
  });

  if (!event) return errorResponse(res, 404, 'Event not found or not upcoming');

  const userId = req.user._id.toString();
  const alreadyRsvp = event.rsvpList.some((id) => id.toString() === userId);

  if (alreadyRsvp) return errorResponse(res, 409, 'You have already RSVP\'d');

  event.rsvpList.push(req.user._id);
  event.rsvpCount = event.rsvpList.length;
  await event.save();
  await event.populate('organiser', 'firstName lastName');

  const response = event.toObject();
  response.hasRsvped = true;

  res.status(200).json({ success: true, event: response });
});

// ─────────────────────────────────────────────────────────
// Create member by admin
// ─────────────────────────────────────────────────────────

const createMemberByAdmin = async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const {
      firstName,
      lastName,
      email,
      phone,
      role = 'member',
      sendWelcomeEmail = true,
      cellGroupId,
    } = req.body;

    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name and email are required',
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address',
      });
    }

    const church = await Church.findById(req.params.churchId);
    if (!church) {
      return res.status(404).json({ success: false, message: 'Church not found' });
    }

    let user = await User.findOne({ email: email.toLowerCase() });
    let isExistingUser = false;

    if (user) {
      isExistingUser = true;

      const existingMembership = await Membership.findOne({
        user: user._id,
        church: req.params.churchId,
      });

      if (existingMembership) {
        return res.status(409).json({
          success: false,
          message: `${firstName} is already a member of this church`,
        });
      }
    } else {
      const tempPassword = `Churza${crypto.randomInt(100000, 999999)}`;
      const hashedPassword = await bcrypt.hash(tempPassword, 12);

      user = await User.create({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.toLowerCase().trim(),
        phone: phone?.trim(),
        passwordHash: hashedPassword,
        isAdminCreated: true,
        mustChangePassword: true,
        isEmailVerified: true,
      });

      if (sendWelcomeEmail) {
        try {
          await sendEmail({
            to: email,
            subject: `Welcome to ${church.name} — Your Churza account`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Welcome to ${church.name}!</h2>
                <p>Hello ${firstName},</p>
                <p>Your pastor has created a Churza account for you to stay connected with ${church.name}.</p>
                <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
                  <p><strong>Email:</strong> ${email}</p>
                  <p><strong>Temporary password:</strong> ${tempPassword}</p>
                </div>
                <p>Please download the Churza app and sign in. You will be asked to change your password on first login.</p>
                <p>God bless you,<br>${church.name}</p>
              </div>
            `,
          });
        } catch (emailErr) {
          console.warn('Welcome email failed:', emailErr.message);
        }
      }
    }

    const prefix = church.name.replace(/\s/g, '').substring(0, 3).toUpperCase();
    const membershipNumber = `${prefix}${Date.now().toString().slice(-6)}`;

    const membership = await Membership.create({
      user: user._id,
      church: req.params.churchId,
      role: ['admin', 'pastor', 'cell_leader', 'deacon', 'worker'].includes(role)
        ? role : 'member',
      status: 'active',
      membershipNumber,
      cellGroup: cellGroupId || undefined,
      joinedAt: new Date(),
      approvedBy: req.user._id,
      approvedAt: new Date(),
    });

    await membership.populate('user', 'firstName lastName email photoUrl phone');

    res.status(201).json({
      success: true,
      membership,
      isExistingUser,
      message: isExistingUser
        ? `${firstName} ${lastName} has been added to your church`
        : `Account created for ${firstName} ${lastName}. ${sendWelcomeEmail ? 'A welcome email has been sent.' : ''}`,
    });

  } catch (err) {
    console.error('createMemberByAdmin error:', err);
    res.status(500).json({
      success: false,
      message: err.code === 11000
        ? 'This email is already registered'
        : 'Failed to create member account',
    });
  }
};

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

module.exports = {
  createChurch,
  getChurch,
  updateChurch,
  deleteChurch,
  joinByCode,
  getMembers,
  getMember,
  approveMember,
  updateMember,
  setMemberStatus,
  getFlaggedMembers,
  getDashboard,
  createSermon,
  getSermons,
  getSermon,
  updateSermon,
  deleteSermon,
  createPrayerRequest,
  getPrayerRequests,
  getPrayerRequest,
  prayForRequest,
  markAnswered,
  deletePrayerRequest,
  createAnnouncement,
  getAnnouncements,
  getAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  createEvent,
  getEvents,
  getEvent,
  updateEvent,
  cancelEvent,
  rsvp,
  createMemberByAdmin,
};