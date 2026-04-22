const Attendance = require('../models/Attendance');
const AttendanceSession = require('../models/AttendanceSession');
const Membership = require('../models/Membership');

// ── Same helpers as userController.js ─────────────────────
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

// ── Start a check-in session ──────────────────────────────
exports.startSession = catchAsync(async (req, res) => {
  const { title, serviceType } = req.body;
  const churchId = req.params.churchId;

  await AttendanceSession.updateMany(
    { church: churchId, isActive: true },
    { isActive: false, endedAt: new Date() }
  );

  const session = await AttendanceSession.create({
    church: churchId,
    title: title || 'Sunday Service',
    serviceType: serviceType || 'sunday',
    startedBy: req.user._id,
    isActive: true,
  });

  res.status(201).json({ success: true, session });
});

// ── End the active session ────────────────────────────────
exports.endSession = catchAsync(async (req, res) => {
  const session = await AttendanceSession.findOneAndUpdate(
    { church: req.params.churchId, isActive: true },
    { isActive: false, endedAt: new Date() },
    { new: true }
  );

  if (!session) return errorResponse(res, 404, 'No active session found');

  res.json({ success: true, session });
});

// ── Get active session ────────────────────────────────────
exports.getActiveSession = catchAsync(async (req, res) => {
  const session = await AttendanceSession.findOne({
    church: req.params.churchId,
    isActive: true,
  }).populate('startedBy', 'firstName lastName');

  res.json({ success: true, session: session || null });
});

// ── One-tap check-in ──────────────────────────────────────
exports.checkIn = catchAsync(async (req, res) => {
  const churchId = req.params.churchId;
  const userId = req.user._id;

  const session = await AttendanceSession.findOne({
    church: churchId,
    isActive: true,
  });

  if (!session) {
    return errorResponse(res, 400,
      'Check-in is not open yet. Wait for your pastor to open check-in.');
  }

  const membership = await Membership.findOne({
    user: userId,
    church: churchId,
    status: 'active',
  });

  if (!membership) {
    return errorResponse(res, 403,
      'You are not an active member of this church');
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const alreadyCheckedIn = await Attendance.findOne({
    church: churchId,
    user: userId,
    checkedInAt: { $gte: today, $lt: tomorrow },
  });

  if (alreadyCheckedIn) {
    return res.json({
      success: true,
      message: 'You are already checked in for this service',
      attendance: alreadyCheckedIn,
      alreadyCheckedIn: true,
    });
  }

  const attendance = await Attendance.create({
    church: churchId,
    user: userId,
    membership: membership._id,
    serviceType: session.serviceType,
    method: 'app',
    checkedInAt: new Date(),
  });

  await AttendanceSession.findByIdAndUpdate(session._id, {
    $inc: { attendeeCount: 1 },
  });

  res.status(201).json({
    success: true,
    message: 'Checked in successfully. God bless you! 🙏',
    attendance,
    alreadyCheckedIn: false,
  });
});

// ── Attendance report ─────────────────────────────────────
exports.getReport = catchAsync(async (req, res) => {
  const { sessionId } = req.query;
  const churchId = req.params.churchId;
  const filter = { church: churchId };

  if (sessionId) {
    const session = await AttendanceSession.findById(sessionId);
    if (session) {
      const start = new Date(session.startedAt);
      start.setHours(0, 0, 0, 0);
      filter.checkedInAt = { $gte: start, $lte: session.endedAt || new Date() };
    }
  }

  const records = await Attendance.find(filter)
    .populate('user', 'firstName lastName photoUrl')
    .populate('membership', 'role membershipNumber')
    .sort({ checkedInAt: -1 });

  res.json({ success: true, count: records.length, records });
});

// ── Past sessions ─────────────────────────────────────────
exports.getSessions = catchAsync(async (req, res) => {
  const sessions = await AttendanceSession.find({
    church: req.params.churchId,
  })
    .populate('startedBy', 'firstName lastName')
    .sort({ startedAt: -1 })
    .limit(20);

  res.json({ success: true, sessions });
});

// ── Usher check-in ────────────────────────────────────────
exports.usherCheckIn = catchAsync(async (req, res) => {
  const { userId } = req.body;
  const churchId = req.params.churchId;

  const session = await AttendanceSession.findOne({
    church: churchId,
    isActive: true,
  });

  if (!session) return errorResponse(res, 400, 'No active check-in session');

  const membership = await Membership.findOne({
    user: userId,
    church: churchId,
    status: 'active',
  });

  if (!membership) return errorResponse(res, 404, 'Member not found in this church');

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const existing = await Attendance.findOne({
    church: churchId,
    user: userId,
    checkedInAt: { $gte: today, $lt: tomorrow },
  });

  if (existing) {
    return res.json({
      success: true,
      message: 'Member already checked in',
      alreadyCheckedIn: true,
    });
  }

  const attendance = await Attendance.create({
    church: churchId,
    user: userId,
    membership: membership._id,
    serviceType: session.serviceType,
    method: 'usher',
    checkedInAt: new Date(),
  });

  await AttendanceSession.findByIdAndUpdate(session._id, {
    $inc: { attendeeCount: 1 },
  });

  res.status(201).json({ success: true, attendance });
});