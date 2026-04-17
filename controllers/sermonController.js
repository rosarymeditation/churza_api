const Sermon = require('../models/Sermon');
const Notification = require('../models/Notification');
const Membership = require('../models/Membership');

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

/**
 * POST /api/churches/:churchId/sermons
 *
 * Upload a new sermon. Media files (audio/video) are uploaded
 * separately to S3/Cloudinary — this endpoint receives the URLs.
 *
 * Body: { title, description, speaker, seriesName, mediaType,
 *         audioUrl, videoUrl, thumbnailUrl, durationSeconds,
 *         tags, bibleReferences, status, scheduledFor }
 * Auth: admin | pastor
 */
const createSermon = catchAsync(async (req, res) => {
  const { title, mediaType } = req.body;

  if (!title) return errorResponse(res, 400, 'Sermon title is required');
  if (!mediaType) return errorResponse(res, 400, 'mediaType is required');
  if (mediaType !== 'video' && !req.body.audioUrl) {
    return errorResponse(res, 400, 'audioUrl is required for audio sermons');
  }
  if (mediaType !== 'audio' && !req.body.videoUrl) {
    return errorResponse(res, 400, 'videoUrl is required for video sermons');
  }

  const sermon = await Sermon.create({
    church: req.params.churchId,
    uploadedBy: req.user._id,
    ...req.body,
    publishedAt: req.body.status === 'published' ? new Date() : undefined,
  });

  // Notify all active members if publishing immediately
  if (sermon.status === 'published') {
    await _notifyMembers(req.params.churchId, sermon);
  }

  res.status(201).json({ success: true, sermon });
});

/**
 * GET /api/churches/:churchId/sermons
 *
 * Returns published sermons visible to members.
 * Admins can also see drafts via ?status=draft.
 *
 * Query: ?page=1&limit=20&status=published&search=grace&tag=faith&series=foundations
 * Auth: active member
 */
const getSermons = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const isAdmin = ['admin', 'pastor'].includes(req.membership?.role);

  const filter = { church: req.params.churchId };

  // Non-admins can only see published sermons
  filter.status = isAdmin && req.query.status ? req.query.status : 'published';

  if (req.query.tag) filter.tags = req.query.tag.toLowerCase();
  if (req.query.series) filter.seriesName = new RegExp(req.query.series, 'i');
  if (req.query.search) {
    const regex = new RegExp(req.query.search, 'i');
    filter.$or = [{ title: regex }, { speaker: regex }, { description: regex }];
  }

  const [sermons, total] = await Promise.all([
    Sermon.find(filter)
      .populate('uploadedBy', 'firstName lastName')
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Sermon.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    sermons,
  });
});

/**
 * GET /api/churches/:churchId/sermons/:sermonId
 *
 * Returns a single sermon and increments the view count.
 *
 * Auth: active member
 */
const getSermon = catchAsync(async (req, res) => {
  const isAdmin = ['admin', 'pastor'].includes(req.membership?.role);

  const sermon = await Sermon.findOne({
    _id: req.params.sermonId,
    church: req.params.churchId,
    ...(isAdmin ? {} : { status: 'published' }),
  }).populate('uploadedBy', 'firstName lastName');

  if (!sermon) return errorResponse(res, 404, 'Sermon not found');

  // Increment view count (fire and forget)
  Sermon.findByIdAndUpdate(sermon._id, { $inc: { views: 1 } }).exec();

  res.status(200).json({ success: true, sermon });
});

/**
 * PATCH /api/churches/:churchId/sermons/:sermonId
 *
 * Update sermon details. Publishing triggers member notifications.
 *
 * Auth: admin | pastor
 */
const updateSermon = catchAsync(async (req, res) => {
  const existing = await Sermon.findOne({
    _id: req.params.sermonId,
    church: req.params.churchId,
  });

  if (!existing) return errorResponse(res, 404, 'Sermon not found');

  const wasUnpublished = existing.status !== 'published';
  const isNowPublished = req.body.status === 'published';

  if (isNowPublished && !req.body.publishedAt) {
    req.body.publishedAt = new Date();
  }

  Object.assign(existing, req.body);
  await existing.save();

  // Notify members if this publish is new
  if (wasUnpublished && isNowPublished) {
    await _notifyMembers(req.params.churchId, existing);
  }

  res.status(200).json({ success: true, sermon: existing });
});

/**
 * DELETE /api/churches/:churchId/sermons/:sermonId
 *
 * Deletes a sermon. Only allowed on drafts in production.
 * Published sermons should be unpublished, not deleted.
 *
 * Auth: admin | pastor
 */
const deleteSermon = catchAsync(async (req, res) => {
  const sermon = await Sermon.findOneAndDelete({
    _id: req.params.sermonId,
    church: req.params.churchId,
  });

  if (!sermon) return errorResponse(res, 404, 'Sermon not found');

  res.status(200).json({ success: true, message: 'Sermon deleted' });
});

/**
 * PATCH /api/churches/:churchId/sermons/:sermonId/download
 *
 * Increments the download counter. Called by the member's
 * app when they tap "Download".
 *
 * Auth: active member
 */
const incrementDownload = catchAsync(async (req, res) => {
  await Sermon.findOneAndUpdate(
    { _id: req.params.sermonId, church: req.params.churchId },
    { $inc: { downloads: 1 } }
  );
  res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────────────────

const _notifyMembers = async (churchId, sermon) => {
  const members = await Membership.find({
    church: churchId,
    status: 'active',
  }).select('user').lean();

  if (!members.length) return;

  await Notification.insertMany(
    members.map((m) => ({
      user: m.user,
      church: churchId,
      type: 'sermon_published',
      title: 'New message available',
      body: `"${sermon.title}"${sermon.speaker ? ` — ${sermon.speaker}` : ''}`,
      data: { screen: 'SermonDetail', sermonId: sermon._id },
    }))
  );
};

module.exports = {
  createSermon,
  getSermons,
  getSermon,
  updateSermon,
  deleteSermon,
  incrementDownload,
};
