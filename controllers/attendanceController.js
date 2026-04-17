const ServiceSession = require('../models/ServiceSession');
const AttendanceRecord = require('../models/AttendanceRecord');
const Membership = require('../models/Membership');
const Church = require('../models/Church');
const Notification = require('../models/Notification');

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

// ─────────────────────────────────────────────────────────
// Service Sessions
// ─────────────────────────────────────────────────────────

/**
 * POST /api/churches/:churchId/sessions
 *
 * Creates and immediately opens a service session.
 * Generates a QR token and bulk-inserts an 'absent' attendance
 * record for every active member so the roster is pre-populated.
 *
 * Body: { title, type, scheduledAt, notes }
 * Auth: admin | pastor
 */
const openSession = catchAsync(async (req, res) => {
  const { title, type, scheduledAt, notes } = req.body;

  if (!title || !scheduledAt) {
    return errorResponse(res, 400, 'title and scheduledAt are required');
  }

  const session = new ServiceSession({
    church: req.params.churchId,
    createdBy: req.user._id,
    title,
    type: type || 'sunday_service',
    scheduledAt: new Date(scheduledAt),
    notes,
  });

  session.openSession(); // generates qrToken + sets status = 'open'
  await session.save();

  // Fetch all active members
  const members = await Membership.find({
    church: req.params.churchId,
    status: 'active',
  }).select('_id user').lean();

  // Bulk-insert one 'absent' record per member
  if (members.length > 0) {
    const records = members.map((m) => ({
      church: req.params.churchId,
      session: session._id,
      membership: m._id,
      user: m.user,
      status: 'absent',
      checkInMethod: 'system',
    }));
    await AttendanceRecord.insertMany(records, { ordered: false });
  }

  // Update expected count snapshot
  session.totalExpected = members.length;
  await session.save();

  res.status(201).json({ success: true, session });
});

/**
 * PATCH /api/churches/:churchId/sessions/:sessionId/close
 *
 * Closes a session, invalidates the QR token, saves summary
 * counts, and triggers the absentee flagging job.
 *
 * Auth: admin | pastor
 */
const closeSession = catchAsync(async (req, res) => {
  const session = await ServiceSession.findOne({
    _id: req.params.sessionId,
    church: req.params.churchId,
    status: 'open',
  });

  if (!session) return errorResponse(res, 404, 'Open session not found');

  // Count final statuses
  const [present, absent, late] = await Promise.all([
    AttendanceRecord.countDocuments({ session: session._id, status: 'present' }),
    AttendanceRecord.countDocuments({ session: session._id, status: 'absent' }),
    AttendanceRecord.countDocuments({ session: session._id, status: 'late' }),
  ]);

  session.closeSession({
    totalExpected: session.totalExpected,
    totalPresent: present,
    totalAbsent: absent,
    totalLate: late,
  });
  await session.save();

  // Run absentee flagging asynchronously — don't block the response
  flagAbsentees(req.params.churchId).catch(console.error);

  res.status(200).json({ success: true, session });
});

/**
 * GET /api/churches/:churchId/sessions
 *
 * Returns paginated list of sessions, most recent first.
 *
 * Query: ?page=1&limit=10&status=closed
 * Auth: admin | pastor | worker
 */
const getSessions = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  const filter = { church: req.params.churchId };
  if (req.query.status) filter.status = req.query.status;

  const [sessions, total] = await Promise.all([
    ServiceSession.find(filter)
      .sort({ scheduledAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('createdBy', 'firstName lastName')
      .lean(),
    ServiceSession.countDocuments(filter),
  ]);

  res.status(200).json({ success: true, total, page, pages: Math.ceil(total / limit), sessions });
});

/**
 * GET /api/churches/:churchId/sessions/:sessionId
 *
 * Returns a single session with its attendance summary.
 *
 * Auth: admin | pastor | worker
 */
const getSession = catchAsync(async (req, res) => {
  const session = await ServiceSession.findOne({
    _id: req.params.sessionId,
    church: req.params.churchId,
  }).populate('createdBy', 'firstName lastName');

  if (!session) return errorResponse(res, 404, 'Session not found');

  res.status(200).json({ success: true, session });
});

// ─────────────────────────────────────────────────────────
// Check-in
// ─────────────────────────────────────────────────────────

/**
 * POST /api/churches/:churchId/sessions/checkin/qr
 *
 * QR self check-in. The member scans the QR and their app
 * sends the token to this endpoint.
 *
 * Body: { qrToken }
 * Auth: active member
 */
const qrCheckIn = catchAsync(async (req, res) => {
  const { qrToken } = req.body;

  if (!qrToken) return errorResponse(res, 400, 'QR token is required');

  // Find the open session this token belongs to
  const session = await ServiceSession.findOne({
    church: req.params.churchId,
    qrToken,
    status: 'open',
    qrExpiresAt: { $gt: new Date() },
  });

  if (!session) {
    return errorResponse(res, 400, 'QR code is invalid or has expired');
  }

  // Find the member's attendance record for this session
  const record = await AttendanceRecord.findOne({
    session: session._id,
    user: req.user._id,
  });

  if (!record) {
    return errorResponse(res, 403, 'You are not registered for this service');
  }

  if (record.status === 'present') {
    return res.status(200).json({ success: true, message: 'Already checked in', record });
  }

  // Mark late if more than 30 minutes after scheduled start
  const minutesLate = (Date.now() - session.scheduledAt.getTime()) / 60000;
  const status = minutesLate > 30 ? 'late' : 'present';

  record.status = status;
  record.checkInMethod = 'qr_scan';
  record.checkedInAt = new Date();
  await record.save();

  // Update member's last attended timestamp
  await Membership.findByIdAndUpdate(record.membership, {
    lastAttendedAt: new Date(),
    consecutiveAbsences: 0,
    isFlagged: false,
  });

  res.status(200).json({
    success: true,
    message: status === 'late' ? 'Checked in (late)' : 'Checked in successfully',
    record,
  });
});

/**
 * PATCH /api/churches/:churchId/sessions/:sessionId/attendance/:membershipId
 *
 * Manual mark by an admin/usher for a specific member.
 *
 * Body: { status: 'present' | 'absent' | 'late' | 'excused', note }
 * Auth: admin | pastor | worker
 */
const manualMark = catchAsync(async (req, res) => {
  const { status, note } = req.body;
  const allowed = ['present', 'absent', 'late', 'excused'];

  if (!allowed.includes(status)) {
    return errorResponse(res, 400, `status must be one of: ${allowed.join(', ')}`);
  }

  const session = await ServiceSession.findOne({
    _id: req.params.sessionId,
    church: req.params.churchId,
    status: 'open',
  });

  if (!session) return errorResponse(res, 404, 'Open session not found');

  const record = await AttendanceRecord.findOneAndUpdate(
    { session: session._id, membership: req.params.membershipId },
    {
      status,
      checkInMethod: 'manual',
      checkedInAt: ['present', 'late'].includes(status) ? new Date() : null,
      markedBy: req.user._id,
      ...(note && { note }),
    },
    { new: true }
  );

  if (!record) return errorResponse(res, 404, 'Attendance record not found');

  // Update member's last attended if marking present/late
  if (['present', 'late'].includes(status)) {
    await Membership.findByIdAndUpdate(req.params.membershipId, {
      lastAttendedAt: new Date(),
      consecutiveAbsences: 0,
      isFlagged: false,
    });
  }

  res.status(200).json({ success: true, record });
});

/**
 * PATCH /api/churches/:churchId/sessions/:sessionId/attendance/bulk
 *
 * Bulk-mark multiple members at once. Used when an usher
 * marks their entire cell group from a list.
 *
 * Body: { records: [{ membershipId, status, note }] }
 * Auth: admin | pastor | worker
 */
const bulkMark = catchAsync(async (req, res) => {
  const { records } = req.body;

  if (!Array.isArray(records) || records.length === 0) {
    return errorResponse(res, 400, 'records array is required');
  }

  const session = await ServiceSession.findOne({
    _id: req.params.sessionId,
    church: req.params.churchId,
    status: 'open',
  });

  if (!session) return errorResponse(res, 404, 'Open session not found');

  const ops = records.map(({ membershipId, status, note }) => ({
    updateOne: {
      filter: { session: session._id, membership: membershipId },
      update: {
        $set: {
          status,
          checkInMethod: 'manual',
          checkedInAt: ['present', 'late'].includes(status) ? new Date() : null,
          markedBy: req.user._id,
          ...(note && { note }),
        },
      },
    },
  }));

  const result = await AttendanceRecord.bulkWrite(ops);

  res.status(200).json({
    success: true,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  });
});

// ─────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────

/**
 * GET /api/churches/:churchId/sessions/:sessionId/report
 *
 * Returns the full attendance roster for a session with
 * per-member status, check-in time, and method.
 *
 * Query: ?status=present&page=1&limit=50
 * Auth: admin | pastor | worker
 */
const getSessionReport = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  const skip = (page - 1) * limit;

  const session = await ServiceSession.findOne({
    _id: req.params.sessionId,
    church: req.params.churchId,
  });

  if (!session) return errorResponse(res, 404, 'Session not found');

  const filter = { session: session._id };
  if (req.query.status) filter.status = req.query.status;

  const [records, total] = await Promise.all([
    AttendanceRecord.find(filter)
      .populate('user', 'firstName lastName phone photoUrl')
      .populate('membership', 'role cellGroup department')
      .populate('markedBy', 'firstName lastName')
      .sort({ checkedInAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AttendanceRecord.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    session,
    total,
    page,
    pages: Math.ceil(total / limit),
    records,
  });
});

/**
 * GET /api/churches/:churchId/attendance/trend
 *
 * Returns attendance count for the last N sessions
 * (default 4) for the dashboard trend chart.
 *
 * Query: ?limit=4
 * Auth: admin | pastor
 */
const getAttendanceTrend = catchAsync(async (req, res) => {
  const limit = Math.min(12, parseInt(req.query.limit) || 4);

  const sessions = await ServiceSession.find({
    church: req.params.churchId,
    status: 'closed',
  })
    .sort({ scheduledAt: -1 })
    .limit(limit)
    .select('title scheduledAt totalPresent totalAbsent totalExpected')
    .lean();

  res.status(200).json({ success: true, trend: sessions.reverse() });
});

/**
 * GET /api/churches/:churchId/members/:membershipId/attendance
 *
 * Returns a member's personal attendance history.
 *
 * Query: ?page=1&limit=20
 * Auth: admin | pastor | worker  (or the member themselves)
 */
const getMemberAttendance = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    AttendanceRecord.find({ membership: req.params.membershipId })
      .populate('session', 'title scheduledAt type')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AttendanceRecord.countDocuments({ membership: req.params.membershipId }),
  ]);

  const presentCount = await AttendanceRecord.countDocuments({
    membership: req.params.membershipId,
    status: { $in: ['present', 'late'] },
  });

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    attendanceRate: total > 0 ? Math.round((presentCount / total) * 100) : 0,
    records,
  });
});

// ─────────────────────────────────────────────────────────
// Absentee flagging job (internal, called after closeSession)
// ─────────────────────────────────────────────────────────

/**
 * For each active member in the church, look at their last
 * N attendance records (N = church.settings.absenteeThreshold).
 * If all are absent, flag them and notify their cell leader.
 *
 * This runs asynchronously after session close — it does not
 * block the API response.
 */
const flagAbsentees = async (churchId) => {
  const church = await Church.findById(churchId).select('settings name');
  const threshold = church?.settings?.absenteeThreshold || 3;

  const members = await Membership.find({
    church: churchId,
    status: 'active',
  }).select('_id user cellGroup consecutiveAbsences isFlagged').lean();

  for (const member of members) {
    // Get their last `threshold` attendance records, newest first
    const recent = await AttendanceRecord.find({ membership: member._id })
      .sort({ createdAt: -1 })
      .limit(threshold)
      .select('status')
      .lean();

    if (recent.length < threshold) continue; // not enough data yet

    const allAbsent = recent.every((r) => r.status === 'absent');

    if (allAbsent && !member.isFlagged) {
      // Flag the member
      await Membership.findByIdAndUpdate(member._id, {
        isFlagged: true,
        flaggedAt: new Date(),
        consecutiveAbsences: threshold,
      });

      // Notify cell group leader if assigned
      if (member.cellGroup) {
        const leaderMembership = await Membership.findOne({
          church: churchId,
          cellGroup: member.cellGroup,
          role: 'cell_leader',
          status: 'active',
        }).select('user');

        if (leaderMembership) {
          const memberUser = await require('../models/User').findById(member.user).select('firstName lastName');
          await Notification.create({
            user: leaderMembership.user,
            church: churchId,
            type: 'attendance_flagged',
            title: 'Member needs follow-up',
            body: `${memberUser?.fullName || 'A member'} has missed ${threshold} consecutive services`,
            data: { screen: 'MemberDetail', membershipId: member._id },
          });
        }
      }
    } else if (!allAbsent && member.isFlagged) {
      // Clear flag if they've attended again
      await Membership.findByIdAndUpdate(member._id, {
        isFlagged: false,
        flaggedAt: null,
        consecutiveAbsences: 0,
      });
    } else if (!allAbsent) {
      // Update consecutive count without flagging
      const absences = recent.filter((r) => r.status === 'absent').length;
      await Membership.findByIdAndUpdate(member._id, { consecutiveAbsences: absences });
    }
  }
};

module.exports = {
  openSession,
  closeSession,
  getSessions,
  getSession,
  qrCheckIn,
  manualMark,
  bulkMark,
  getSessionReport,
  getAttendanceTrend,
  getMemberAttendance,
};
