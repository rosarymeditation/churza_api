const Attendance = require("../models/Attendance");
const AttendanceSession = require("../models/AttendanceSession");
const Membership = require("../models/Membership");
const { notifyCheckInOpened } = require("../utils/churchNotifications");

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).send({ error: true, message });

module.exports = {
  startSession: catchAsync(async (req, res) => {
    const { title, serviceType } = req.body;
    const churchId = req.params.churchId;

    // close out any session thats still open before starting a new one
    await AttendanceSession.updateMany(
      { church: churchId, isActive: true },
      { isActive: false, endedAt: new Date() }
    );

    const session = await AttendanceSession.create({
      church: churchId,
      title: title || "Sunday Service",
      serviceType: serviceType || "sunday",
      startedBy: req.user._id,
      isActive: true,
    });

    // let members know check in is open now
    notifyCheckInOpened({
      churchId: churchId,
      sessionTitle: session.title,
    });

    return res.status(201).send({ error: false, data: session });
  }),

  endSession: catchAsync(async (req, res) => {
    const session = await AttendanceSession.findOneAndUpdate(
      { church: req.params.churchId, isActive: true },
      { isActive: false, endedAt: new Date() },
      { new: true }
    );

    if (!session) return errorResponse(res, 404, "No active session found");

    return res.send({ error: false, data: session });
  }),

  getActiveSession: catchAsync(async (req, res) => {
    const session = await AttendanceSession.findOne({
      church: req.params.churchId,
      isActive: true,
    }).populate("startedBy", "firstName lastName");

    return res.send({ error: false, data: session || null });
  }),

  // hits this on home screen load to decide which banner to show -
  // gold "tap to check in" or green "you're checked in"
  getMyAttendanceToday: catchAsync(async (req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const record = await Attendance.findOne({
      church: req.params.churchId,
      user: req.user._id,
      checkedInAt: { $gte: today, $lt: tomorrow },
    }).lean();

    return res.send({ error: false, data: record || null });
  }),

  checkIn: catchAsync(async (req, res) => {
    const churchId = req.params.churchId;
    const userId = req.user._id;

    const session = await AttendanceSession.findOne({
      church: churchId,
      isActive: true,
    });

    if (!session) {
      return errorResponse(
        res,
        400,
        "Check-in is not open yet. Wait for your pastor to open check-in."
      );
    }

    const membership = await Membership.findOne({
      user: userId,
      church: churchId,
      status: "active",
    });

    if (!membership) {
      return errorResponse(res, 403, "You are not an active member of this church");
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const alreadyCheckedIn = await Attendance.findOne({
      church: churchId,
      user: userId,
      checkedInAt: { $gte: today, $lt: tomorrow },
    });

    if (alreadyCheckedIn) {
      return res.send({
        error: false,
        message: "You are already checked in for this service",
        data: alreadyCheckedIn,
        alreadyCheckedIn: true,
      });
    }

    const attendance = await Attendance.create({
      church: churchId,
      user: userId,
      membership: membership._id,
      serviceType: session.serviceType,
      method: "app",
      checkedInAt: new Date(),
    });

    await AttendanceSession.findByIdAndUpdate(session._id, {
      $inc: { attendeeCount: 1 },
    });

    return res.status(201).send({
      error: false,
      message: "Checked in successfully. God bless you! 🙏",
      data: attendance,
      alreadyCheckedIn: false,
    });
  }),

  getReport: catchAsync(async (req, res) => {
    const { sessionId } = req.query;
    const churchId = req.params.churchId;
    const filter = { church: churchId };

    if (sessionId) {
      const session = await AttendanceSession.findById(sessionId);
      if (session) {
        const start = new Date(session.startedAt);
        start.setHours(0, 0, 0, 0);
        filter.checkedInAt = {
          $gte: start,
          $lte: session.endedAt || new Date(),
        };
      }
    }

    const records = await Attendance.find(filter)
      .populate("user", "firstName lastName photoUrl")
      .populate("membership", "role membershipNumber")
      .sort({ checkedInAt: -1 });

    return res.send({ error: false, count: records.length, data: records });
  }),

  getSessions: catchAsync(async (req, res) => {
    const sessions = await AttendanceSession.find({
      church: req.params.churchId,
    })
      .populate("startedBy", "firstName lastName")
      .sort({ startedAt: -1 })
      .limit(20);

    return res.send({ error: false, data: sessions });
  }),

  // for ushers checking in members who dont have the app open / arent using self checkin
  usherCheckIn: catchAsync(async (req, res) => {
    const { userId } = req.body;
    const churchId = req.params.churchId;

    const session = await AttendanceSession.findOne({
      church: churchId,
      isActive: true,
    });

    if (!session) return errorResponse(res, 400, "No active check-in session");

    const membership = await Membership.findOne({
      user: userId,
      church: churchId,
      status: "active",
    });

    if (!membership) {
      return errorResponse(res, 404, "Member not found in this church");
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const existing = await Attendance.findOne({
      church: churchId,
      user: userId,
      checkedInAt: { $gte: today, $lt: tomorrow },
    });

    if (existing) {
      return res.send({
        error: false,
        message: "Member already checked in",
        alreadyCheckedIn: true,
      });
    }

    const attendance = await Attendance.create({
      church: churchId,
      user: userId,
      membership: membership._id,
      serviceType: session.serviceType,
      method: "usher",
      checkedInAt: new Date(),
    });

    await AttendanceSession.findByIdAndUpdate(session._id, {
      $inc: { attendeeCount: 1 },
    });

    return res.status(201).send({ error: false, data: attendance });
  }),
};