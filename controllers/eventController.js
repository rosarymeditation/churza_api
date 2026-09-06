const Event = require("../models/Event");
const EventRsvp = require("../models/EventRsvp");
const Membership = require("../models/Membership");
const Notification = require("../models/Notification");

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).send({ error: true, message });

module.exports = {
  createEvent: catchAsync(async (req, res) => {
    const { title, startsAt, endsAt } = req.body;

    if (!title) return errorResponse(res, 400, "Event title is required");
    if (!startsAt || !endsAt) return errorResponse(res, 400, "startsAt and endsAt are required");
    if (new Date(startsAt) >= new Date(endsAt)) {
      return errorResponse(res, 400, "endsAt must be after startsAt");
    }

    const event = await Event.create({
      church: req.params.churchId,
      createdBy: req.user._id,
      ...req.body,
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
    });

    // only blast notifications if its going live right away, not a draft
    if (event.status === "published") {
      await _notifyMembers(req.params.churchId, event);
    }

    return res.status(201).send({ error: false, data: event });
  }),

  getEvents: catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;

    const isAdmin = ["admin", "pastor"].includes(req.membership?.role);

    // regular members only ever see published, admins can filter by whatever status
    const filter = {
      church: req.params.churchId,
      status: isAdmin && req.query.status ? req.query.status : "published",
    };

    if (req.query.category) filter.category = req.query.category;
    if (req.query.upcoming === "true") filter.startsAt = { $gte: new Date() };

    const [events, total] = await Promise.all([
      Event.find(filter)
        .sort({ startsAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Event.countDocuments(filter),
    ]);

    return res.send({
      error: false,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: events,
    });
  }),

  getEvent: catchAsync(async (req, res) => {
    const event = await Event.findOne({
      _id: req.params.eventId,
      church: req.params.churchId,
    }).populate("createdBy", "firstName lastName");

    if (!event) return errorResponse(res, 404, "Event not found");

    const rsvp = await EventRsvp.findOne({
      event: event._id,
      membership: req.membership._id,
    }).lean();

    return res.send({ error: false, data: { event, myRsvp: rsvp || null } });
  }),

  updateEvent: catchAsync(async (req, res) => {
    const existing = await Event.findOne({
      _id: req.params.eventId,
      church: req.params.churchId,
    });

    if (!existing) return errorResponse(res, 404, "Event not found");

    const wasUnpublished = existing.status !== "published";
    const isNowPublished = req.body.status === "published";

    Object.assign(existing, req.body);
    if (req.body.startsAt) existing.startsAt = new Date(req.body.startsAt);
    if (req.body.endsAt) existing.endsAt = new Date(req.body.endsAt);
    await existing.save();

    // draft -> published transition is the only time we notify here
    if (wasUnpublished && isNowPublished) {
      await _notifyMembers(req.params.churchId, existing);
    }

    return res.send({ error: false, data: existing });
  }),

  cancelEvent: catchAsync(async (req, res) => {
    const event = await Event.findOneAndUpdate(
      { _id: req.params.eventId, church: req.params.churchId },
      { status: "cancelled" },
      { new: true }
    );

    if (!event) return errorResponse(res, 404, "Event not found");

    // only ping people who actually said they were going, not everyone
    const rsvps = await EventRsvp.find({ event: event._id, status: "going" }).select("user").lean();
    if (rsvps.length) {
      await Notification.insertMany(
        rsvps.map((r) => ({
          user: r.user,
          church: req.params.churchId,
          type: "event_reminder",
          title: "Event cancelled",
          body: `"${event.title}" has been cancelled`,
          data: { screen: "Events" },
        }))
      );
    }

    return res.send({ error: false, message: "Event cancelled", data: event });
  }),

  rsvp: catchAsync(async (req, res) => {
    const { status } = req.body;
    const allowed = ["going", "not_going", "maybe"];

    if (!allowed.includes(status)) {
      return errorResponse(res, 400, `status must be one of: ${allowed.join(", ")}`);
    }

    const event = await Event.findOne({
      _id: req.params.eventId,
      church: req.params.churchId,
      status: "published",
    });

    if (!event) return errorResponse(res, 404, "Event not found");

    // only bother checking capacity for going, not maybe/not_going
    if (status === "going" && event.capacity) {
      const goingCount = await EventRsvp.countDocuments({
        event: event._id,
        status: "going",
      });
      if (goingCount >= event.capacity) {
        return errorResponse(res, 400, "This event is at full capacity");
      }
    }

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

    // bump/drop the cached rsvpCount depending on the going/not-going transition
    const delta = _rsvpDelta(prevStatus, status);
    if (delta !== 0) {
      await Event.findByIdAndUpdate(event._id, { $inc: { rsvpCount: delta } });
    }

    return res.send({ error: false, data: rsvpRecord });
  }),

  getEventRsvps: catchAsync(async (req, res) => {
    const filter = { event: req.params.eventId };
    if (req.query.status) filter.status = req.query.status;

    const rsvps = await EventRsvp.find(filter)
      .populate("user", "firstName lastName phone photoUrl")
      .sort({ createdAt: 1 })
      .lean();

    return res.send({ error: false, total: rsvps.length, data: rsvps });
  }),

  // for ushers/workers scanning people in at the door
  checkInAtEvent: catchAsync(async (req, res) => {
    const rsvp = await EventRsvp.findOneAndUpdate(
      { _id: req.params.rsvpId, event: req.params.eventId },
      { checkedIn: true, checkedInAt: new Date() },
      { new: true }
    );

    if (!rsvp) return errorResponse(res, 404, "RSVP not found");

    return res.send({ error: false, data: rsvp });
  }),
};

// true when someone flips into "going", false the other way, else no change needed
const _rsvpDelta = (prev, next) => {
  const wasGoing = prev === "going";
  const isGoing = next === "going";
  if (!wasGoing && isGoing) return 1;
  if (wasGoing && !isGoing) return -1;
  return 0;
};

// blasts in app notifications to every active member, used on publish
const _notifyMembers = async (churchId, event) => {
  const members = await Membership.find({
    church: churchId,
    status: "active",
  }).select("user").lean();

  if (!members.length) return;

  await Notification.insertMany(
    members.map((m) => ({
      user: m.user,
      church: churchId,
      type: "event_reminder",
      title: "New event announced",
      body: `${event.title} — ${new Date(event.startsAt).toDateString()}`,
      data: { screen: "EventDetail", eventId: event._id },
    }))
  );
};