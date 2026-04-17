const Announcement = require('../models/Announcement');
const Membership = require('../models/Membership');
const Notification = require('../models/Notification');

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

/**
 * POST /api/churches/:churchId/announcements
 *
 * Create and optionally send an announcement immediately.
 *
 * Body: { title, body, audience, targetCellGroup, targetDepartment,
 *         imageUrl, isPinned, scheduledFor, expiresAt }
 * Auth: admin | pastor
 */
const createAnnouncement = catchAsync(async (req, res) => {
  const { title, body, scheduledFor } = req.body;

  if (!title || !body) return errorResponse(res, 400, 'title and body are required');

  const sendNow = !scheduledFor;

  const announcement = await Announcement.create({
    church: req.params.churchId,
    createdBy: req.user._id,
    ...req.body,
    status: sendNow ? 'sent' : 'scheduled',
    sentAt: sendNow ? new Date() : undefined,
    scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
  });

  if (sendNow) {
    // Dispatch push notifications asynchronously
    _sendPushNotifications(req.params.churchId, announcement).catch(console.error);
  }

  res.status(201).json({ success: true, announcement });
});

/**
 * GET /api/churches/:churchId/announcements
 *
 * Member feed — returns sent, non-expired, visible announcements.
 * Pinned announcements appear first.
 *
 * Query: ?page=1&limit=20
 * Auth: active member
 */
const getAnnouncements = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const isAdmin = ['admin', 'pastor'].includes(req.membership?.role);

  const filter = { church: req.params.churchId };

  if (!isAdmin) {
    filter.status = 'sent';
    filter.$or = [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } },
    ];
  }

  const [announcements, total] = await Promise.all([
    Announcement.find(filter)
      .populate('createdBy', 'firstName lastName')
      .sort({ isPinned: -1, sentAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Announcement.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    announcements,
  });
});

/**
 * GET /api/churches/:churchId/announcements/:announcementId
 *
 * Single announcement.
 *
 * Auth: active member
 */
const getAnnouncement = catchAsync(async (req, res) => {
  const announcement = await Announcement.findOne({
    _id: req.params.announcementId,
    church: req.params.churchId,
  }).populate('createdBy', 'firstName lastName');

  if (!announcement) return errorResponse(res, 404, 'Announcement not found');

  res.status(200).json({ success: true, announcement });
});

/**
 * PATCH /api/churches/:churchId/announcements/:announcementId
 *
 * Update a draft announcement. Cannot edit a sent announcement.
 *
 * Auth: admin | pastor
 */
const updateAnnouncement = catchAsync(async (req, res) => {
  const announcement = await Announcement.findOne({
    _id: req.params.announcementId,
    church: req.params.churchId,
  });

  if (!announcement) return errorResponse(res, 404, 'Announcement not found');

  if (announcement.status === 'sent') {
    // Allow only pin toggle and expiry update on sent announcements
    const editable = ['isPinned', 'expiresAt'];
    editable.forEach((f) => {
      if (req.body[f] !== undefined) announcement[f] = req.body[f];
    });
  } else {
    Object.assign(announcement, req.body);
  }

  await announcement.save();
  res.status(200).json({ success: true, announcement });
});

/**
 * DELETE /api/churches/:churchId/announcements/:announcementId
 *
 * Hard-deletes a draft announcement or hides a sent one.
 *
 * Auth: admin | pastor
 */
const deleteAnnouncement = catchAsync(async (req, res) => {
  const announcement = await Announcement.findOneAndDelete({
    _id: req.params.announcementId,
    church: req.params.churchId,
  });

  if (!announcement) return errorResponse(res, 404, 'Announcement not found');

  res.status(200).json({ success: true, message: 'Announcement deleted' });
});

/**
 * POST /api/churches/:churchId/announcements/:announcementId/send
 *
 * Manually trigger send for a scheduled announcement.
 *
 * Auth: admin | pastor
 */
const sendAnnouncement = catchAsync(async (req, res) => {
  const announcement = await Announcement.findOne({
    _id: req.params.announcementId,
    church: req.params.churchId,
    status: { $in: ['draft', 'scheduled'] },
  });

  if (!announcement) return errorResponse(res, 404, 'Unsent announcement not found');

  announcement.status = 'sent';
  announcement.sentAt = new Date();
  await announcement.save();

  _sendPushNotifications(req.params.churchId, announcement).catch(console.error);

  res.status(200).json({ success: true, announcement });
});

// ─────────────────────────────────────────────────────────
// Internal helper — push notifications
// ─────────────────────────────────────────────────────────

const _sendPushNotifications = async (churchId, announcement) => {
  // Build audience filter
  const memberFilter = { church: churchId, status: 'active' };

  if (announcement.audience === 'workers') {
    memberFilter.role = { $in: ['worker', 'cell_leader', 'deacon', 'pastor', 'admin'] };
  } else if (announcement.audience === 'leaders') {
    memberFilter.role = { $in: ['cell_leader', 'deacon', 'pastor', 'admin'] };
  } else if (announcement.audience === 'cell_group' && announcement.targetCellGroup) {
    memberFilter.cellGroup = announcement.targetCellGroup;
  } else if (announcement.audience === 'department' && announcement.targetDepartment) {
    memberFilter.department = announcement.targetDepartment;
  }

  const members = await Membership.find(memberFilter).select('user').lean();

  if (!members.length) return;

  // Create in-app notifications
  await Notification.insertMany(
    members.map((m) => ({
      user: m.user,
      church: churchId,
      type: 'announcement',
      title: announcement.title,
      body: announcement.body.length > 100
        ? announcement.body.substring(0, 97) + '...'
        : announcement.body,
      data: { screen: 'AnnouncementDetail', announcementId: announcement._id },
    }))
  );

  // Update sent count on announcement
  await Announcement.findByIdAndUpdate(announcement._id, {
    pushSentCount: members.length,
  });

  // TODO: integrate FCM/APNs here
  // const tokens = await User.find({ _id: { $in: memberIds } }).select('pushTokens')
  // await fcm.sendMulticast({ tokens: flatTokens, notification: { title, body } })
};

module.exports = {
  createAnnouncement,
  getAnnouncements,
  getAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  sendAnnouncement,
};
