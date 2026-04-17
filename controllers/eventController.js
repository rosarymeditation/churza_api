const Event = require('../models/Event');
const EventRsvp = require('../models/EventRsvp');
const Membership = require('../models/Membership');
const Notification = require('../models/Notification');

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

/**
 * POST /api/churches/:churchId/events
 *
 * Create a new event.
 *
 * Body: { title, description, category, location, startsAt,
 *         endsAt, requiresRsvp, capacity, rsvpDeadline, coverImageUrl }
 * Auth: admin | pastor
 */
const createEvent = catchAsync(async (req, res) => {
  const { title, startsAt, endsAt } = req.body;

  if (!title) return errorResponse(res, 400, 'Event title is required');
  if (!startsAt || !endsAt) return errorResponse(res, 400, 'startsAt and endsAt are required');
  if (new Date(startsAt) >= new Date(endsAt)) {
    return errorResponse(res, 400, 'endsAt must be after startsAt');
  }

  const event = await Event.create({
    church: req.params.churchId,
    createdBy: req.user._id,
    ...req.body,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
  });

  // Notify all members if publishing immediately
  if (event.status === 'published') {
    await _notifyMembers(req.params.churchId, event);
  }

  res.status(201).json({ success: true, event });
});

/**
 * GET /api/churches/:churchId/events
 *
 * Returns upcoming published events. Admins see all including drafts.
 *
 * Query: ?page=1&limit=10&status=published&category=conference&upcoming=true
 * Auth: active member
 */
const getEvents = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const skip = (page - 1) * limit;

  const isAdmin = ['admin', 'pastor'].includes(req.membership?.role);

  const filter = {
    church: req.params.churchId,
    status: isAdmin && req.query.status ? req.query.status : 'published',
  };

  if (req.query.category) filter.category = req.query.category;
  if (req.query.upcoming === 'true') filter.startsAt = { $gte: new Date() };

  const [events, total] = await Promise.all([
    Event.find(filter)
      .sort({ startsAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Event.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    events,
  });
});

/**
 * GET /api/churches/:churchId/events/:eventId
 *
 * Returns a single event. If the member has RSVPed, includes
 * their RSVP status.
 *
 * Auth: active member
 */
const getEvent = catchAsync(async (req, res) => {
  const event = await Event.findOne({
    _id: req.params.eventId,
    church: req.params.churchId,
  }).populate('createdBy', 'firstName lastName');

  if (!event) return errorResponse(res, 404, 'Event not found');

  const rsvp = await EventRsvp.findOne({
    event: event._id,
    membership: req.membership._id,
  }).lean();

  res.status(200).json({ success: true, event, myRsvp: rsvp || null });
});

/**
 * PATCH /api/churches/:churchId/events/:eventId
 *
 * Update an event. Publishing sends notifications.
 *
 * Auth: admin | pastor
 */
const updateEvent = catchAsync(async (req, res) => {
  const existing = await Event.findOne({
    _id: req.params.eventId,
    church: req.params.churchId,
  });

  if (!existing) return errorResponse(res, 404, 'Event not found');

  const wasUnpublished = existing.status !== 'published';
  const isNowPublished = req.body.status === 'published';

  Object.assign(existing, req.body);
  if (req.body.startsAt) existing.startsAt = new Date(req.body.startsAt);
  if (req.body.endsAt) existing.endsAt = new Date(req.body.endsAt);
  await existing.save();

  if (wasUnpublished && isNowPublished) {
    await _notifyMembers(req.params.churchId, existing);
  }

  res.status(200).json({ success: true, event: existing });
});

/**
 * DELETE /api/churches/:churchId/events/:eventId
 *
 * Cancels an event (status = 'cancelled').
 *
 * Auth: admin | pastor
 */
const cancelEvent = catchAsync(async (req, res) => {
  const event = await Event.findOneAndUpdate(
    { _id: req.params.eventId, church: req.params.churchId },
    { status: 'cancelled' },
    { new: true }
  );

  if (!event) return errorResponse(res, 404, 'Event not found');

  // Notify all RSVPed members
  const rsvps = await EventRsvp.find({ event: event._id, status: 'going' }).select('user').lean();
  if (rsvps.length) {
    await Notification.insertMany(
      rsvps.map((r) => ({
        user: r.user,
        church: req.params.churchId,
        type: 'event_reminder',
        title: 'Event cancelled',
        body: `"${event.title}" has been cancelled`,
        data: { screen: 'Events' },
      }))
    );
  }

  res.status(200).json({ success: true, message: 'Event cancelled', event });
});

// ─────────────────────────────────────────────────────────
// RSVP
// ─────────────────────────────────────────────────────────

/**
 * POST /api/churches/:churchId/events/:eventId/rsvp
 *
 * RSVP or update RSVP for an event.
 *
 * Body: { status: 'going' | 'not_going' | 'maybe' }
 * Auth: active member
 */
const rsvp = catchAsync(async (req, res) => {
  const { status } = req.body;
  const allowed = ['going', 'not_going', 'maybe'];

  if (!allowed.includes(status)) {
    return errorResponse(res, 400, `status must be one of: ${allowed.join(', ')}`);
  }

  const event = await Event.findOne({
    _id: req.params.eventId,
    church: req.params.churchId,
    status: 'published',
  });

  if (!event) return errorResponse(res, 404, 'Event not found');

  // Check capacity before allowing 'going' RSVP
  if (status === 'going' && event.capacity) {
    const goingCount = await EventRsvp.countDocuments({
      event: event._id,
      status: 'going',
    });
    if (goingCount >= event.capacity) {
      return errorResponse(res, 400, 'This event is at full capacity');
    }
  }

  // Upsert RSVP record
  const existingRsvp = await EventRsvp.findOne({
    event: event._id,
    membership: req.membership._id,
  });

  let rsvpRecord;
  let prevStatus = existingRsvp?.status;

  if (existingRsvp) {
    existingRsvp.status = status;
    rsvpRecord = await existingRsvp.save();
  } else {
    rsvpRecord = await EventRsvp.create({
      event: event._id,
      church: req.params.churchId,
      membership: req.membership._id,
      user: req.user._id,
      status,
    });
  }

  // Adjust event's rsvpCount
  const delta = _rsvpDelta(prevStatus, status);
  if (delta !== 0) {
    await Event.findByIdAndUpdate(event._id, { $inc: { rsvpCount: delta } });
  }

  res.status(200).json({ success: true, rsvp: rsvpRecord });
});

/**
 * GET /api/churches/:churchId/events/:eventId/rsvps
 *
 * Admin view of all RSVPs for an event.
 *
 * Query: ?status=going
 * Auth: admin | pastor | worker
 */
const getEventRsvps = catchAsync(async (req, res) => {
  const filter = { event: req.params.eventId };
  if (req.query.status) filter.status = req.query.status;

  const rsvps = await EventRsvp.find(filter)
    .populate('user', 'firstName lastName phone photoUrl')
    .sort({ createdAt: 1 })
    .lean();

  res.status(200).json({ success: true, total: rsvps.length, rsvps });
});

/**
 * PATCH /api/churches/:churchId/events/:eventId/rsvps/:rsvpId/checkin
 *
 * Physically check in a member at the event venue.
 *
 * Auth: admin | pastor | worker
 */
const checkInAtEvent = catchAsync(async (req, res) => {
  const rsvp = await EventRsvp.findOneAndUpdate(
    { _id: req.params.rsvpId, event: req.params.eventId },
    { checkedIn: true, checkedInAt: new Date() },
    { new: true }
  );

  if (!rsvp) return errorResponse(res, 404, 'RSVP not found');

  res.status(200).json({ success: true, rsvp });
});

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const _rsvpDelta = (prev, next) => {
  const wasGoing = prev === 'going';
  const isGoing = next === 'going';
  if (!wasGoing && isGoing) return 1;
  if (wasGoing && !isGoing) return -1;
  return 0;
};

const _notifyMembers = async (churchId, event) => {
  const members = await Membership.find({
    church: churchId,
    status: 'active',
  }).select('user').lean();

  if (!members.length) return;

  await Notification.insertMany(
    members.map((m) => ({
      user: m.user,
      church: churchId,
      type: 'event_reminder',
      title: 'New event announced',
      body: `${event.title} — ${new Date(event.startsAt).toDateString()}`,
      data: { screen: 'EventDetail', eventId: event._id },
    }))
  );
};

module.exports = {
  createEvent,
  getEvents,
  getEvent,
  updateEvent,
  cancelEvent,
  rsvp,
  getEventRsvps,
  checkInAtEvent,
};
