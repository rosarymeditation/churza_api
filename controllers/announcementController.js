const Announcement = require("../models/Announcement");
const Membership = require("../models/Membership");
const Notification = require("../models/Notification");

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).send({ error: true, message });

module.exports = {
  // creates an announcement, sends right away unless scheduledFor is set
  createAnnouncement: catchAsync(async (req, res) => {
    const { title, body, scheduledFor } = req.body;

    if (!title || !body) return errorResponse(res, 400, "title and body are required");

    const sendNow = !scheduledFor;

    const announcement = await Announcement.create({
      church: req.params.churchId,
      createdBy: req.user._id,
      ...req.body,
      status: sendNow ? "sent" : "scheduled",
      sentAt: sendNow ? new Date() : undefined,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
    });

    if (sendNow) {
      // fire and forget, dont block the response on push delivery
      _sendPushNotifications(req.params.churchId, announcement).catch(console.error);
    }

    return res.status(201).send({ error: false, data: announcement });
  }),

  // member feed - sent + not expired only, unless caller is admin/pastor
  getAnnouncements: catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const isAdmin = ["admin", "pastor"].includes(req.membership?.role);

    const filter = { church: req.params.churchId };

    if (!isAdmin) {
      filter.status = "sent";
      filter.$or = [
        { expiresAt: { $exists: false } },
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } },
      ];
    }

    const [announcements, total] = await Promise.all([
      Announcement.find(filter)
        .populate("createdBy", "firstName lastName")
        .sort({ isPinned: -1, sentAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Announcement.countDocuments(filter),
    ]);

    return res.send({
      error: false,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: announcements,
    });
  }),

  getAnnouncement: catchAsync(async (req, res) => {
    const announcement = await Announcement.findOne({
      _id: req.params.announcementId,
      church: req.params.churchId,
    }).populate("createdBy", "firstName lastName");

    if (!announcement) return errorResponse(res, 404, "Announcement not found");

    return res.send({ error: false, data: announcement });
  }),

  // cant edit a sent announcement fully - only pin + expiry after it goes out
  updateAnnouncement: catchAsync(async (req, res) => {
    const announcement = await Announcement.findOne({
      _id: req.params.announcementId,
      church: req.params.churchId,
    });

    if (!announcement) return errorResponse(res, 404, "Announcement not found");

    if (announcement.status === "sent") {
      const editable = ["isPinned", "expiresAt"];
      editable.forEach((f) => {
        if (req.body[f] !== undefined) announcement[f] = req.body[f];
      });
    } else {
      Object.assign(announcement, req.body);
    }

    await announcement.save();
    return res.send({ error: false, data: announcement });
  }),

  deleteAnnouncement: catchAsync(async (req, res) => {
    const announcement = await Announcement.findOneAndDelete({
      _id: req.params.announcementId,
      church: req.params.churchId,
    });

    if (!announcement) return errorResponse(res, 404, "Announcement not found");

    return res.send({ error: false, message: "Announcement deleted" });
  }),

  // manual trigger for a draft/scheduled announcement thats still unsent
  sendAnnouncement: catchAsync(async (req, res) => {
    const announcement = await Announcement.findOne({
      _id: req.params.announcementId,
      church: req.params.churchId,
      status: { $in: ["draft", "scheduled"] },
    });

    if (!announcement) return errorResponse(res, 404, "Unsent announcement not found");

    announcement.status = "sent";
    announcement.sentAt = new Date();
    await announcement.save();

    _sendPushNotifications(req.params.churchId, announcement).catch(console.error);

    return res.send({ error: false, data: announcement });
  }),
};

// internal - builds the audience list and drops in-app notifications for them
const _sendPushNotifications = async (churchId, announcement) => {
  const memberFilter = { church: churchId, status: "active" };

  if (announcement.audience === "workers") {
    memberFilter.role = { $in: ["worker", "cell_leader", "deacon", "pastor", "admin"] };
  } else if (announcement.audience === "leaders") {
    memberFilter.role = { $in: ["cell_leader", "deacon", "pastor", "admin"] };
  } else if (announcement.audience === "cell_group" && announcement.targetCellGroup) {
    memberFilter.cellGroup = announcement.targetCellGroup;
  } else if (announcement.audience === "department" && announcement.targetDepartment) {
    memberFilter.department = announcement.targetDepartment;
  }

  const members = await Membership.find(memberFilter).select("user").lean();

  if (!members.length) return;

  await Notification.insertMany(
    members.map((m) => ({
      user: m.user,
      church: churchId,
      type: "announcement",
      title: announcement.title,
      body: announcement.body.length > 100
        ? announcement.body.substring(0, 97) + "..."
        : announcement.body,
      data: { screen: "AnnouncementDetail", announcementId: announcement._id },
    }))
  );

  await Announcement.findByIdAndUpdate(announcement._id, {
    pushSentCount: members.length,
  });

  // still need to wire up actual push delivery (FCM/APNs) - right now this only writes in app notifications
  // const tokens = await User.find({ _id: { $in: memberIds } }).select('pushTokens')
  // await fcm.sendMulticast({ tokens: flatTokens, notification: { title, body } })
};