const express = require('express');
const router = express.Router();
const { protect, restrictTo, requireChurchRole } = require('../middleware/auth');
const c = require('../controllers/churchController');
const upload = require('../middleware/upload');
// ── Helper — safely wrap a handler that may not exist yet ──
// Prevents "Route.post() requires a callback" crash when a
// controller function hasn't been implemented yet.
function safe(fn) {
    if (typeof fn === 'function') return fn;
    return (req, res) => res.status(501).json({
        success: false,
        message: `${fn?.name || 'Handler'} not implemented yet`,
    });
}

// ── Church ────────────────────────────────────────────────
router.post('/', protect, safe(c.createChurch));
router.post('/join', protect, safe(c.joinByCode));

router.get('/:churchId', protect, safe(c.getChurch));
router.patch('/:churchId', protect, safe(c.updateChurch));
router.delete('/:churchId', protect, safe(c.deleteChurch));

// ── Dashboard ─────────────────────────────────────────────
router.get('/:churchId/dashboard', protect, safe(c.getDashboard));

// ── Members ───────────────────────────────────────────────
router.get('/:churchId/members', protect, safe(c.getMembers));
router.get('/:churchId/members/flagged', protect, safe(c.getFlaggedMembers));
router.get('/:churchId/members/:id', protect, safe(c.getMember));
router.patch('/:churchId/members/:id', protect, safe(c.updateMember));
router.patch('/:churchId/members/:id/approve', protect, safe(c.approveMember));
router.patch('/:churchId/members/:id/status', protect, safe(c.setMemberStatus));

// ── Attendance ────────────────────────────────────────────
router.post('/:churchId/sessions', protect, safe(c.openSession));
router.get('/:churchId/sessions', protect, safe(c.getSessions));
router.get('/:churchId/sessions/:sid', protect, safe(c.getSession));
router.patch('/:churchId/sessions/:sid', protect, safe(c.closeSession));
router.post('/:churchId/sessions/checkin/qr', protect, safe(c.qrCheckIn));
router.get('/:churchId/sessions/:sid/report', protect, safe(c.getSessionReport));
router.get('/:churchId/attendance/trend', protect, safe(c.getAttendanceTrend));

// ── Giving ────────────────────────────────────────────────
router.post('/:churchId/giving', protect, safe(c.recordGiving));
router.get('/:churchId/giving', protect, safe(c.getChurchGiving));
router.get('/:churchId/giving/me', protect, safe(c.getMyGiving));
// Webhook — no auth, raw body
router.post(
    '/:churchId/giving/webhook',
    express.raw({ type: 'application/json' }),
    safe(c.verifyPayment)
);

// ── Sermons ───────────────────────────────────────────────
router.post(
    '/:churchId/sermons',
    (req, res, next) => { console.log('🔥 sermon route hit'); next(); }, // ← add this
    protect,
    (req, res, next) => { console.log('🔥 after protect'); next(); },    // ← add this
    requireChurchRole('admin', 'pastor'),
    (req, res, next) => { console.log('🔥 after requireChurchRole'); next(); }, // ← add
    upload.single('file'),
    (req, res, next) => { console.log('🔥 after multer'); next(); },     // ← add this
    safe(c.createSermon)
);
router.get('/:churchId/sermons', protect, safe(c.getSermons));
router.get('/:churchId/sermons/:sid', protect, safe(c.getSermon));
router.patch('/:churchId/sermons/:sid', protect, safe(c.updateSermon));
router.delete('/:churchId/sermons/:sid', protect, safe(c.deleteSermon));

// ── Prayer ────────────────────────────────────────────────
router.post('/:churchId/prayer', protect, safe(c.createPrayerRequest));
router.get('/:churchId/prayer', protect, safe(c.getPrayerRequests));
router.get('/:churchId/prayer/:pid', protect, safe(c.getPrayerRequest));
router.delete('/:churchId/prayer/:pid', protect, safe(c.deletePrayerRequest));
router.patch('/:churchId/prayer/:pid/pray', protect, safe(c.prayForRequest));
router.patch('/:churchId/prayer/:pid/answered', protect, safe(c.markAnswered));

// ── Events ────────────────────────────────────────────────
router.post('/:churchId/events', protect, safe(c.createEvent));
router.get('/:churchId/events', protect, safe(c.getEvents));
router.get('/:churchId/events/:eid', protect, safe(c.getEvent));
router.patch('/:churchId/events/:eid', protect, safe(c.updateEvent));
router.patch('/:churchId/events/:eid/cancel', protect, safe(c.cancelEvent));
router.post('/:churchId/events/:eid/rsvp', protect, safe(c.rsvp));

// ── Announcements ─────────────────────────────────────────
router.post('/:churchId/announcements', protect, safe(c.createAnnouncement));
router.get('/:churchId/announcements', protect, safe(c.getAnnouncements));
router.get('/:churchId/announcements/:aid', protect, safe(c.getAnnouncement));
router.patch('/:churchId/announcements/:aid', protect, safe(c.updateAnnouncement));
router.delete('/:churchId/announcements/:aid', protect, safe(c.deleteAnnouncement));

module.exports = router;