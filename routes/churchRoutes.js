const controller = require("../controllers/churchController");
const attendanceController = require("../controllers/attendanceController");
const givingController = require("../controllers/givingController");
const { rootUrl } = require("../utils/constants");
const { protect, restrictTo, requireChurchRole } = require("../middleware/auth");
const upload = require("../middleware/upload");
const express = require("express");

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

    // attendance
    // attendance
    app.post(rootUrl("/:churchId/sessions"), protect, safe(attendanceController.startSession));
    app.get(rootUrl("/:churchId/sessions"), protect, safe(attendanceController.getSessions));
    app.patch(rootUrl("/:churchId/sessions/:sid"), protect, safe(attendanceController.endSession));
    app.get(rootUrl("/:churchId/checkin/today"), protect, safe(attendanceController.getMyAttendanceToday));
    app.post(rootUrl("/:churchId/checkin"), protect, safe(attendanceController.checkIn));
    app.get(rootUrl("/:churchId/sessions/:sid/report"), protect, safe(attendanceController.getReport));
    app.post(rootUrl("/:churchId/checkin/usher"), protect, requireChurchRole("admin", "pastor", "cell_leader"), safe(attendanceController.usherCheckIn));
    // giving
    app.post(rootUrl("/:churchId/giving"), protect, safe(givingController.recordGiving));
    app.get(rootUrl("/:churchId/giving"), protect, safe(givingController.getChurchGiving));
    app.get(rootUrl("/:churchId/giving/me"), protect, safe(givingController.getMyGiving));
    app.post(
        rootUrl("/:churchId/giving/webhook"),
        express.raw({ type: "application/json" }),
        safe(givingController.verifyPayment)
    );

   

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