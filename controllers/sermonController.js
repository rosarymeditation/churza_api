const Sermon = require("../models/Sermon");
const Notification = require("../models/Notification");
const Membership = require("../models/Membership");

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).send({ error: true, message });

async function createSermon(req, res, next) {
  try {
    const { title, mediaType } = req.body;
    if (!title) return errorResponse(res, 400, "Sermon title is required");
    if (!mediaType) return errorResponse(res, 400, "mediaType is required");
    if (mediaType !== "video" && !req.body.audioUrl) {
      return errorResponse(res, 400, "audioUrl is required for audio sermons");
    }
    if (mediaType !== "audio" && !req.body.videoUrl) {
      return errorResponse(res, 400, "videoUrl is required for video sermons");
    }

    const sermon = await Sermon.create({
      church: req.params.churchId,
      uploadedBy: req.user._id,
      ...req.body,
      publishedAt: req.body.status === "published" ? new Date() : undefined,
    });

    // only ping members if this goes out live right away
    if (sermon.status === "published") {
      await _notifyMembers(req.params.churchId, sermon);
    }

    res.status(201).send({ error: false, data: sermon });
  } catch (err) {
    next(err);
  }
}

const getSermons = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const isAdmin = ["admin", "pastor"].includes(req.membership?.role);
  const filter = { church: req.params.churchId };
  // regular members only get published, admins can pick a status
  filter.status = isAdmin && req.query.status ? req.query.status : "published";

  if (req.query.tag) filter.tags = req.query.tag.toLowerCase();
  if (req.query.series) filter.seriesName = new RegExp(req.query.series, "i");
  if (req.query.search) {
    const regex = new RegExp(req.query.search, "i");
    filter.$or = [{ title: regex }, { speaker: regex }, { description: regex }];
  }

  const [sermons, total] = await Promise.all([
    Sermon.find(filter)
      .populate("uploadedBy", "firstName lastName")
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Sermon.countDocuments(filter),
  ]);

  return res.json({
    error: false,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: sermons,
  });
});

exports.getSermon = catchAsync(async (req, res) => {
  const isAdmin = ["admin", "pastor"].includes(req.membership?.role);

  const sermon = await Sermon.findOne({
    _id: req.params.sermonId,
    church: req.params.churchId,
    ...(isAdmin ? {} : { status: "published" }),
  }).populate("uploadedBy", "firstName lastName");

  if (!sermon) return errorResponse(res, 404, "Sermon not found");

  // fire and forget, dont block the response on this
  Sermon.findByIdAndUpdate(sermon._id, { $inc: { views: 1 } }).exec();

  res.send({ error: false, data: sermon });
});

const updateSermon = async (req, res) => {
  try {
    const existing = await Sermon.findOne({
      _id: req.params.sermonId,
      church: req.params.churchId,
    });

    if (!existing) return errorResponse(res, 404, "Sermon not found");

    const wasUnpublished = existing.status !== "published";
    const isNowPublished = req.body.status === "published";

    if (isNowPublished && !req.body.publishedAt) {
      req.body.publishedAt = new Date();
    }

    Object.assign(existing, req.body);
    await existing.save();

    // only notify on the draft -> published transition, not every edit
    if (wasUnpublished && isNowPublished) {
      await _notifyMembers(req.params.churchId, existing);
    }

    res.status(200).send({ error: false, data: existing });
  } catch (err) {
    console.log(err);
    res.status(500).send({ error: true, message: "Server error" });
  }
};

const deleteSermon = catchAsync(async (req, res) => {
  // note: original comment said published sermons should be unpublished
  // instead of deleted, but nothing here actually enforces that yet
  const sermon = await Sermon.findOneAndDelete({
    _id: req.params.sermonId,
    church: req.params.churchId,
  });

  if (!sermon) return errorResponse(res, 404, "Sermon not found");

  res.send({ error: false, message: "Sermon deleted" });
});

async function incrementDownload(req, res) {
  await Sermon.findOneAndUpdate(
    { _id: req.params.sermonId, church: req.params.churchId },
    { $inc: { downloads: 1 } }
  );
  res.send({ error: false });
}

// pushes an in-app notification to every active member of the church
async function _notifyMembers(churchId, sermon) {
  const members = await Membership.find({
    church: churchId,
    status: "active",
  }).select("user").lean();

  if (!members.length) return;

  await Notification.insertMany(
    members.map((m) => ({
      user: m.user,
      church: churchId,
      type: "sermon_published",
      title: "New message available",
      body: `"${sermon.title}"${sermon.speaker ? ` — ${sermon.speaker}` : ""}`,
      data: { screen: "SermonDetail", sermonId: sermon._id },
    }))
  );
}

module.exports = {
  createSermon,
  getSermons,
  getSermon: exports.getSermon,
  updateSermon,
  deleteSermon,
  incrementDownload,
};