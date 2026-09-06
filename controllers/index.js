const { rootUrl } = require("../utility/constants");
const { protect, requireChurchRole, requireActiveMembership } = require("../middleware/auth");

// Controllers
const churchCtrl = require("../controllers/churchController");
const attendanceCtrl = require("../controllers/attendanceController");
const givingCtrl = require("../controllers/givingController");
const sermonCtrl = require("../controllers/sermonController");
const prayerCtrl = require("../controllers/prayerController");
const eventCtrl = require("../controllers/eventController");
const announcementCtrl = require("../controllers/announcementController");
const cellGroupCtrl = require("../controllers/cellGroupController");

// Shorthand role guards (used after protect)
const adminOnly = requireChurchRole("admin", "pastor");
const staffOnly = requireChurchRole("admin", "pastor", "worker", "cell_leader");
const memberOnly = requireActiveMembership;

module.exports = (app) => {
    // ── Church ───────────────────────────────────────────────
    app.post(rootUrl("/churches"), protect, churchCtrl.createChurch);
    app.post(rootUrl("/churches/join"), protect, churchCtrl.joinByCode);
    app.get(rootUrl("/churches/:churchId"), protect, memberOnly, churchCtrl.getChurch);
    app.patch(rootUrl("/churches/:churchId"), protect, adminOnly, churchCtrl.updateChurch);
    app.delete(rootUrl("/churches/:churchId"), protect, requireChurchRole("admin"), churchCtrl.deleteChurch);
    app.get(rootUrl("/churches/:churchId/dashboard"), protect, adminOnly, churchCtrl.getDashboard);

    // ── Members ──────────────────────────────────────────────
    // static routes (flagged) before :membershipId, same reasoning as churchRoutes.js
    app.get(rootUrl("/churches/:churchId/members"), protect, staffOnly, churchCtrl.getMembers);
    app.get(rootUrl("/churches/:churchId/members/flagged"), protect, staffOnly, churchCtrl.getFlaggedMembers);
    app.get(rootUrl("/churches/:churchId/members/:membershipId"), protect, staffOnly, churchCtrl.getMember);
    app.patch(rootUrl("/churches/:churchId/members/:membershipId/approve"), protect, adminOnly, churchCtrl.approveMember);
    app.patch(rootUrl("/churches/:churchId/members/:membershipId"), protect, adminOnly, churchCtrl.updateMember);
    app.patch(rootUrl("/churches/:churchId/members/:membershipId/status"), protect, adminOnly, churchCtrl.setMemberStatus);

    // ── Cell Groups ──────────────────────────────────────────
    app.post(rootUrl("/churches/:churchId/cell-groups"), protect, adminOnly, cellGroupCtrl.createCellGroup);
    app.get(rootUrl("/churches/:churchId/cell-groups"), protect, memberOnly, cellGroupCtrl.getCellGroups);
    app.get(rootUrl("/churches/:churchId/cell-groups/:cellGroupId"), protect, memberOnly, cellGroupCtrl.getCellGroup);
    app.patch(rootUrl("/churches/:churchId/cell-groups/:cellGroupId"), protect, adminOnly, cellGroupCtrl.updateCellGroup);
    app.delete(rootUrl("/churches/:churchId/cell-groups/:cellGroupId"), protect, adminOnly, cellGroupCtrl.deleteCellGroup);
    app.patch(rootUrl("/churches/:churchId/cell-groups/:cellGroupId/assign"), protect, adminOnly, cellGroupCtrl.assignMembers);

    // ── Attendance ───────────────────────────────────────────
    app.post(rootUrl("/churches/:churchId/sessions"), protect, adminOnly, attendanceCtrl.openSession);
    app.get(rootUrl("/churches/:churchId/sessions"), protect, staffOnly, attendanceCtrl.getSessions);
    app.get(rootUrl("/churches/:churchId/sessions/:sessionId"), protect, staffOnly, attendanceCtrl.getSession);
    app.patch(rootUrl("/churches/:churchId/sessions/:sessionId/close"), protect, adminOnly, attendanceCtrl.closeSession);
    app.post(rootUrl("/churches/:churchId/sessions/checkin/qr"), protect, memberOnly, attendanceCtrl.qrCheckIn);
    app.patch(rootUrl("/churches/:churchId/sessions/:sessionId/attendance/:membershipId"), protect, staffOnly, attendanceCtrl.manualMark);
    app.patch(rootUrl("/churches/:churchId/sessions/:sessionId/attendance/bulk"), protect, staffOnly, attendanceCtrl.bulkMark);
    app.get(rootUrl("/churches/:churchId/sessions/:sessionId/report"), protect, staffOnly, attendanceCtrl.getSessionReport);
    app.get(rootUrl("/churches/:churchId/attendance/trend"), protect, adminOnly, attendanceCtrl.getAttendanceTrend);
    app.get(rootUrl("/churches/:churchId/members/:membershipId/attendance"), protect, staffOnly, attendanceCtrl.getMemberAttendance);

    // ── Giving ───────────────────────────────────────────────
    // Webhook — no auth (called by payment gateway) — SEE WARNING BELOW
    app.post(rootUrl("/giving/webhook"), givingCtrl.verifyPayment);

    app.post(rootUrl("/churches/:churchId/giving"), protect, memberOnly, givingCtrl.recordGiving);
    app.get(rootUrl("/churches/:churchId/giving"), protect, adminOnly, givingCtrl.getChurchGiving);
    app.get(rootUrl("/churches/:churchId/giving/me"), protect, memberOnly, givingCtrl.getMyGiving);
    app.get(rootUrl("/churches/:churchId/giving/:transactionId/receipt"), protect, memberOnly, givingCtrl.getReceipt);

    // Pledges
    app.post(rootUrl("/churches/:churchId/pledges"), protect, memberOnly, givingCtrl.createPledge);
    app.get(rootUrl("/churches/:churchId/pledges/me"), protect, memberOnly, givingCtrl.getMyPledges);
    app.get(rootUrl("/churches/:churchId/pledges"), protect, adminOnly, givingCtrl.getChurchPledges);

    // ── Sermons ──────────────────────────────────────────────
    app.post(rootUrl("/churches/:churchId/sermons"), protect, adminOnly, sermonCtrl.createSermon);
    app.get(rootUrl("/churches/:churchId/sermons"), protect, memberOnly, sermonCtrl.getSermons);
    app.get(rootUrl("/churches/:churchId/sermons/:sermonId"), protect, memberOnly, sermonCtrl.getSermon);
    app.patch(rootUrl("/churches/:churchId/sermons/:sermonId"), protect, adminOnly, sermonCtrl.updateSermon);
    app.delete(rootUrl("/churches/:churchId/sermons/:sermonId"), protect, adminOnly, sermonCtrl.deleteSermon);
    app.patch(rootUrl("/churches/:churchId/sermons/:sermonId/download"), protect, memberOnly, sermonCtrl.incrementDownload);

    // ── Prayer Wall ──────────────────────────────────────────
    app.post(rootUrl("/churches/:churchId/prayer"), protect, memberOnly, prayerCtrl.createPrayerRequest);
    app.get(rootUrl("/churches/:churchId/prayer"), protect, memberOnly, prayerCtrl.getPrayerRequests);
    app.get(rootUrl("/churches/:churchId/prayer/:prayerId"), protect, memberOnly, prayerCtrl.getPrayerRequest);
    app.post(rootUrl("/churches/:churchId/prayer/:prayerId/pray"), protect, memberOnly, prayerCtrl.prayForRequest);
    app.patch(rootUrl("/churches/:churchId/prayer/:prayerId/answered"), protect, memberOnly, prayerCtrl.markAnswered);
    app.patch(rootUrl("/churches/:churchId/prayer/:prayerId/approve"), protect, adminOnly, prayerCtrl.approvePrayerRequest);
    app.delete(rootUrl("/churches/:churchId/prayer/:prayerId"), protect, memberOnly, prayerCtrl.deletePrayerRequest);

    // ── Events ───────────────────────────────────────────────
    app.post(rootUrl("/churches/:churchId/events"), protect, adminOnly, eventCtrl.createEvent);
    app.get(rootUrl("/churches/:churchId/events"), protect, memberOnly, eventCtrl.getEvents);
    app.get(rootUrl("/churches/:churchId/events/:eventId"), protect, memberOnly, eventCtrl.getEvent);
    app.patch(rootUrl("/churches/:churchId/events/:eventId"), protect, adminOnly, eventCtrl.updateEvent);
    app.delete(rootUrl("/churches/:churchId/events/:eventId"), protect, adminOnly, eventCtrl.cancelEvent);
    app.post(rootUrl("/churches/:churchId/events/:eventId/rsvp"), protect, memberOnly, eventCtrl.rsvp);
    app.get(rootUrl("/churches/:churchId/events/:eventId/rsvps"), protect, staffOnly, eventCtrl.getEventRsvps);
    app.patch(rootUrl("/churches/:churchId/events/:eventId/rsvps/:rsvpId/checkin"), protect, staffOnly, eventCtrl.checkInAtEvent);

    // ── Announcements ────────────────────────────────────────
    app.post(rootUrl("/churches/:churchId/announcements"), protect, adminOnly, announcementCtrl.createAnnouncement);
    app.get(rootUrl("/churches/:churchId/announcements"), protect, memberOnly, announcementCtrl.getAnnouncements);
    app.get(rootUrl("/churches/:churchId/announcements/:announcementId"), protect, memberOnly, announcementCtrl.getAnnouncement);
    app.patch(rootUrl("/churches/:churchId/announcements/:announcementId"), protect, adminOnly, announcementCtrl.updateAnnouncement);
    app.delete(rootUrl("/churches/:churchId/announcements/:announcementId"), protect, adminOnly, announcementCtrl.deleteAnnouncement);
    app.post(rootUrl("/churches/:churchId/announcements/:announcementId/send"), protect, adminOnly, announcementCtrl.sendAnnouncement);
};