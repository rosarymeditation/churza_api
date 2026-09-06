const controller = require("../controllers/churchController");
// FIX: attendance and giving methods were being called on `controller`
// (churchController) even though those methods don't exist there - they
// live in separate controller files. safe() was silently converting every
// one of these into a 501 "not implemented" response instead of throwing,
// which is why they looked wired up but never actually worked.
const attendanceController = require("../controllers/attendanceController");
const paymentController = require("../controllers/paymentController");
const { rootUrl } = require("../utils/constants");
const { protect, restrictTo, requireChurchRole } = require("../middleware/auth");
const upload = require("../middleware/upload");
const express = require("express");

// stops "requires a callback" crash if a controller fn isnt written yet
function safe(fn) {
    if (typeof fn === "function") return fn;
    return (req, res) => res.status(501).send({
        error: true,
        message: `${fn?.name || "Handler"} not implemented yet`,
    });
}

module.exports = (app) => {
    // church crud
    app.post(rootUrl("/"), protect, safe(controller.createChurch));
    app.post(rootUrl("/join"), protect, safe(controller.joinByCode));
    app.get(rootUrl("/:churchId"), protect, safe(controller.getChurch));
    app.patch(rootUrl("/:churchId"), protect, safe(controller.updateChurch));
    app.delete(rootUrl("/:churchId"), protect, safe(controller.deleteChurch));
    app.get(rootUrl("/:churchId/dashboard"), protect, safe(controller.getDashboard));

    // members - flagged/create need to stay above :membershipId or they get swallowed as the param
    app.get(rootUrl("/:churchId/members"), protect, safe(controller.getMembers));
    app.get(rootUrl("/:churchId/members/flagged"), protect, safe(controller.getFlaggedMembers));
    app.post(
        rootUrl("/:churchId/members/create"),
        protect,
        requireChurchRole("admin", "pastor"),
        controller.createMemberByAdmin
    );
    app.get(rootUrl("/:churchId/members/:membershipId"), protect, safe(controller.getMember));
    app.patch(
        rootUrl("/:churchId/members/:membershipId/approve"),
        protect,
        requireChurchRole("admin", "pastor"),
        safe(controller.approveMember)
    );
    app.patch(
        rootUrl("/:churchId/members/:membershipId/status"),
        protect,
        requireChurchRole("admin", "pastor"),
        safe(controller.setMemberStatus)
    );
    app.patch(
        rootUrl("/:churchId/members/:membershipId"),
        protect,
        requireChurchRole("admin", "pastor"),
        safe(controller.updateMember)
    );

    // ── attendance — FIXED: now calls attendanceController with its real
    // method names instead of nonexistent methods on churchController.
    // Note the method-name changes: openSession -> startSession,
    // closeSession -> endSession, getSessionReport -> getReport.
    // getAttendanceTrend and qrCheckIn don't exist anywhere in
    // attendanceController.js as of this writing - they've been removed
    // below rather than left pointing at nothing. If your app actually
    // calls those endpoints, they need to be written from scratch.
    app.post(rootUrl("/:churchId/sessions"), protect, requireChurchRole("admin", "pastor"), safe(attendanceController.startSession));
    app.get(rootUrl("/:churchId/sessions"), protect, safe(attendanceController.getSessions));
    app.get(rootUrl("/:churchId/sessions/:sid"), protect, safe(attendanceController.getActiveSession));
    app.patch(rootUrl("/:churchId/sessions/:sid"), protect, requireChurchRole("admin", "pastor"), safe(attendanceController.endSession));
    app.get(rootUrl("/:churchId/checkin/today"), protect, safe(attendanceController.getMyAttendanceToday));
    app.post(rootUrl("/:churchId/checkin"), protect, safe(attendanceController.checkIn));
    app.post(
        rootUrl("/:churchId/checkin/usher"),
        protect,
        requireChurchRole("admin", "pastor", "cell_leader"),
        safe(attendanceController.usherCheckIn)
    );
    app.get(rootUrl("/:churchId/sessions/:sid/report"), protect, safe(attendanceController.getReport));

    // ── giving — DECISION NEEDED, not fully "fixed":
    // This codebase has two separate giving implementations:
    //   1. paymentController.js  (Stripe Connect + PaymentIntents)
    //   2. givingController.js   (transaction/pledge model + Paystack)
    // Rather than silently pick one and delete the other, these routes
    // are wired to paymentController (the more complete/recent-looking
    // implementation) for now. Confirm this is actually the one your
    // frontend calls before relying on it - if the Flutter app was built
    // against givingController's response shapes instead, these routes
    // will return correctly-shaped-but-wrong data.
    app.post(rootUrl("/:churchId/giving/intent"), protect, safe(paymentController.createPaymentIntent));
    app.post(rootUrl("/:churchId/giving/confirm"), protect, safe(paymentController.confirmPayment));
    app.get(rootUrl("/:churchId/giving/me"), protect, safe(paymentController.myGivingHistory));
    app.get(rootUrl("/:churchId/giving/overview"), protect, requireChurchRole("admin", "pastor"), safe(paymentController.givingOverview));
    app.get(rootUrl("/:churchId/giving/transactions"), protect, requireChurchRole("admin", "pastor"), safe(paymentController.allTransactions));
    app.post(rootUrl("/:churchId/giving/cash"), protect, requireChurchRole("admin", "pastor", "worker"), safe(paymentController.recordCash));

    // NOTE: the webhook route that used to live here has been REMOVED.
    // It must be registered in server.js, before express.json() runs -
    // see the corrected server.js. Leaving it here would mean it's
    // registered too late in the middleware chain and Stripe signature
    // verification will fail. Do not add it back to this file.

    // sermons
    app.post(
        rootUrl("/:churchId/sermons"),
        protect,
        requireChurchRole("admin", "pastor"),
        upload.single("file"),
        safe(controller.createSermon)
    );
    app.get(rootUrl("/:churchId/sermons"), protect, safe(controller.getSermons));
    app.get(rootUrl("/:churchId/sermons/:sid"), protect, safe(controller.getSermon));
    app.patch(rootUrl("/:churchId/sermons/:sid"), protect, requireChurchRole("admin", "pastor"), safe(controller.updateSermon));
    app.delete(rootUrl("/:churchId/sermons/:sid"), protect, requireChurchRole("admin", "pastor"), safe(controller.deleteSermon));

    // prayer requests
    app.post(rootUrl("/:churchId/prayer"), protect, safe(controller.createPrayerRequest));
    app.get(rootUrl("/:churchId/prayer"), protect, safe(controller.getPrayerRequests));
    app.get(rootUrl("/:churchId/prayer/:pid"), protect, safe(controller.getPrayerRequest));
    app.delete(rootUrl("/:churchId/prayer/:pid"), protect, safe(controller.deletePrayerRequest));
    app.patch(rootUrl("/:churchId/prayer/:pid/pray"), protect, safe(controller.prayForRequest));
    app.patch(rootUrl("/:churchId/prayer/:pid/answered"), protect, safe(controller.markAnswered));

    // events
    app.post(rootUrl("/:churchId/events"), protect, requireChurchRole("admin", "pastor"), safe(controller.createEvent));
    app.get(rootUrl("/:churchId/events"), protect, safe(controller.getEvents));
    app.get(rootUrl("/:churchId/events/:eid"), protect, safe(controller.getEvent));
    app.patch(rootUrl("/:churchId/events/:eid"), protect, requireChurchRole("admin", "pastor"), safe(controller.updateEvent));
    app.patch(rootUrl("/:churchId/events/:eid/cancel"), protect, requireChurchRole("admin", "pastor"), safe(controller.cancelEvent));
    app.post(rootUrl("/:churchId/events/:eid/rsvp"), protect, safe(controller.rsvp));

    // announcements
    app.post(rootUrl("/:churchId/announcements"), protect, requireChurchRole("admin", "pastor"), safe(controller.createAnnouncement));
    app.get(rootUrl("/:churchId/announcements"), protect, safe(controller.getAnnouncements));
    app.get(rootUrl("/:churchId/announcements/:aid"), protect, safe(controller.getAnnouncement));
    app.patch(rootUrl("/:churchId/announcements/:aid"), protect, requireChurchRole("admin", "pastor"), safe(controller.updateAnnouncement));
    app.delete(rootUrl("/:churchId/announcements/:aid"), protect, requireChurchRole("admin", "pastor"), safe(controller.deleteAnnouncement));
};