const express = require('express');
const router = express.Router();

const { protect, requireChurchRole, requireActiveMembership } = require('../middleware/auth');

// Controllers
const churchCtrl       = require('../controllers/churchController');
const attendanceCtrl   = require('../controllers/attendanceController');
const givingCtrl       = require('../controllers/givingController');
const sermonCtrl       = require('../controllers/sermonController');
const prayerCtrl       = require('../controllers/prayerController');
const eventCtrl        = require('../controllers/eventController');
const announcementCtrl = require('../controllers/announcementController');
const cellGroupCtrl    = require('../controllers/cellGroupController');

// Shorthand role guards (used after protect)
const adminOnly   = requireChurchRole('admin', 'pastor');
const staffOnly   = requireChurchRole('admin', 'pastor', 'worker', 'cell_leader');
const memberOnly  = requireActiveMembership;

// ─────────────────────────────────────────────────────────
// Church
// ─────────────────────────────────────────────────────────
router.post('/churches',                protect, churchCtrl.createChurch);
router.post('/churches/join',           protect, churchCtrl.joinByCode);
router.get( '/churches/:churchId',      protect, memberOnly, churchCtrl.getChurch);
router.patch('/churches/:churchId',     protect, adminOnly,  churchCtrl.updateChurch);
router.delete('/churches/:churchId',    protect, requireChurchRole('admin'), churchCtrl.deleteChurch);
router.get('/churches/:churchId/dashboard', protect, adminOnly, churchCtrl.getDashboard);

// ─── Members ───────────────────────────────────────────
router.get(  '/churches/:churchId/members',                           protect, staffOnly,  churchCtrl.getMembers);
router.get(  '/churches/:churchId/members/flagged',                   protect, staffOnly,  churchCtrl.getFlaggedMembers);
router.get(  '/churches/:churchId/members/:membershipId',             protect, staffOnly,  churchCtrl.getMember);
router.patch('/churches/:churchId/members/:membershipId/approve',     protect, adminOnly,  churchCtrl.approveMember);
router.patch('/churches/:churchId/members/:membershipId',             protect, adminOnly,  churchCtrl.updateMember);
router.patch('/churches/:churchId/members/:membershipId/status',      protect, adminOnly,  churchCtrl.setMemberStatus);

// ─────────────────────────────────────────────────────────
// Cell Groups
// ─────────────────────────────────────────────────────────
router.post( '/churches/:churchId/cell-groups',                          protect, adminOnly,  cellGroupCtrl.createCellGroup);
router.get(  '/churches/:churchId/cell-groups',                          protect, memberOnly, cellGroupCtrl.getCellGroups);
router.get(  '/churches/:churchId/cell-groups/:cellGroupId',             protect, memberOnly, cellGroupCtrl.getCellGroup);
router.patch('/churches/:churchId/cell-groups/:cellGroupId',             protect, adminOnly,  cellGroupCtrl.updateCellGroup);
router.delete('/churches/:churchId/cell-groups/:cellGroupId',            protect, adminOnly,  cellGroupCtrl.deleteCellGroup);
router.patch('/churches/:churchId/cell-groups/:cellGroupId/assign',      protect, adminOnly,  cellGroupCtrl.assignMembers);

// ─────────────────────────────────────────────────────────
// Attendance
// ─────────────────────────────────────────────────────────
router.post( '/churches/:churchId/sessions',                                            protect, adminOnly,  attendanceCtrl.openSession);
router.get(  '/churches/:churchId/sessions',                                            protect, staffOnly,  attendanceCtrl.getSessions);
router.get(  '/churches/:churchId/sessions/:sessionId',                                 protect, staffOnly,  attendanceCtrl.getSession);
router.patch('/churches/:churchId/sessions/:sessionId/close',                           protect, adminOnly,  attendanceCtrl.closeSession);
router.post( '/churches/:churchId/sessions/checkin/qr',                                 protect, memberOnly, attendanceCtrl.qrCheckIn);
router.patch('/churches/:churchId/sessions/:sessionId/attendance/:membershipId',        protect, staffOnly,  attendanceCtrl.manualMark);
router.patch('/churches/:churchId/sessions/:sessionId/attendance/bulk',                 protect, staffOnly,  attendanceCtrl.bulkMark);
router.get(  '/churches/:churchId/sessions/:sessionId/report',                          protect, staffOnly,  attendanceCtrl.getSessionReport);
router.get(  '/churches/:churchId/attendance/trend',                                    protect, adminOnly,  attendanceCtrl.getAttendanceTrend);
router.get(  '/churches/:churchId/members/:membershipId/attendance',                    protect, staffOnly,  attendanceCtrl.getMemberAttendance);

// ─────────────────────────────────────────────────────────
// Giving
// ─────────────────────────────────────────────────────────
// Webhook — no auth middleware (called by payment gateway)
router.post('/giving/webhook', givingCtrl.verifyPayment);

router.post('/churches/:churchId/giving',                           protect, memberOnly, givingCtrl.recordGiving);
router.get( '/churches/:churchId/giving',                           protect, adminOnly,  givingCtrl.getChurchGiving);
router.get( '/churches/:churchId/giving/me',                        protect, memberOnly, givingCtrl.getMyGiving);
router.get( '/churches/:churchId/giving/:transactionId/receipt',    protect, memberOnly, givingCtrl.getReceipt);

// Pledges
router.post('/churches/:churchId/pledges',          protect, memberOnly, givingCtrl.createPledge);
router.get( '/churches/:churchId/pledges/me',        protect, memberOnly, givingCtrl.getMyPledges);
router.get( '/churches/:churchId/pledges',           protect, adminOnly,  givingCtrl.getChurchPledges);

// ─────────────────────────────────────────────────────────
// Sermons
// ─────────────────────────────────────────────────────────
router.post(  '/churches/:churchId/sermons',                        protect, adminOnly,  sermonCtrl.createSermon);
router.get(   '/churches/:churchId/sermons',                        protect, memberOnly, sermonCtrl.getSermons);
router.get(   '/churches/:churchId/sermons/:sermonId',              protect, memberOnly, sermonCtrl.getSermon);
router.patch( '/churches/:churchId/sermons/:sermonId',              protect, adminOnly,  sermonCtrl.updateSermon);
router.delete('/churches/:churchId/sermons/:sermonId',              protect, adminOnly,  sermonCtrl.deleteSermon);
router.patch( '/churches/:churchId/sermons/:sermonId/download',     protect, memberOnly, sermonCtrl.incrementDownload);

// ─────────────────────────────────────────────────────────
// Prayer Wall
// ─────────────────────────────────────────────────────────
router.post(  '/churches/:churchId/prayer',                           protect, memberOnly, prayerCtrl.createPrayerRequest);
router.get(   '/churches/:churchId/prayer',                           protect, memberOnly, prayerCtrl.getPrayerRequests);
router.get(   '/churches/:churchId/prayer/:prayerId',                 protect, memberOnly, prayerCtrl.getPrayerRequest);
router.post(  '/churches/:churchId/prayer/:prayerId/pray',            protect, memberOnly, prayerCtrl.prayForRequest);
router.patch( '/churches/:churchId/prayer/:prayerId/answered',        protect, memberOnly, prayerCtrl.markAnswered);
router.patch( '/churches/:churchId/prayer/:prayerId/approve',         protect, adminOnly,  prayerCtrl.approvePrayerRequest);
router.delete('/churches/:churchId/prayer/:prayerId',                 protect, memberOnly, prayerCtrl.deletePrayerRequest);

// ─────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────
router.post(  '/churches/:churchId/events',                                 protect, adminOnly,  eventCtrl.createEvent);
router.get(   '/churches/:churchId/events',                                 protect, memberOnly, eventCtrl.getEvents);
router.get(   '/churches/:churchId/events/:eventId',                        protect, memberOnly, eventCtrl.getEvent);
router.patch( '/churches/:churchId/events/:eventId',                        protect, adminOnly,  eventCtrl.updateEvent);
router.delete('/churches/:churchId/events/:eventId',                        protect, adminOnly,  eventCtrl.cancelEvent);
router.post(  '/churches/:churchId/events/:eventId/rsvp',                   protect, memberOnly, eventCtrl.rsvp);
router.get(   '/churches/:churchId/events/:eventId/rsvps',                  protect, staffOnly,  eventCtrl.getEventRsvps);
router.patch( '/churches/:churchId/events/:eventId/rsvps/:rsvpId/checkin',  protect, staffOnly,  eventCtrl.checkInAtEvent);

// ─────────────────────────────────────────────────────────
// Announcements
// ─────────────────────────────────────────────────────────
router.post(  '/churches/:churchId/announcements',                          protect, adminOnly,  announcementCtrl.createAnnouncement);
router.get(   '/churches/:churchId/announcements',                          protect, memberOnly, announcementCtrl.getAnnouncements);
router.get(   '/churches/:churchId/announcements/:announcementId',          protect, memberOnly, announcementCtrl.getAnnouncement);
router.patch( '/churches/:churchId/announcements/:announcementId',          protect, adminOnly,  announcementCtrl.updateAnnouncement);
router.delete('/churches/:churchId/announcements/:announcementId',          protect, adminOnly,  announcementCtrl.deleteAnnouncement);
router.post(  '/churches/:churchId/announcements/:announcementId/send',     protect, adminOnly,  announcementCtrl.sendAnnouncement);

module.exports = router;
