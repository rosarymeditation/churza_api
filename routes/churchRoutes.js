const express = require('express');
const router = express.Router();
const { protect, restrictTo, requireChurchRole } = require('../middleware/auth');
const c = require('../controllers/churchController');
const upload = require('../middleware/upload');

// ── Helper — safely wrap a handler that may not exist yet ──
// Prevents "Route.post() requires a callback" crash when a
// controller function has not been implemented yet.
function safe(fn) {
    if (typeof fn === 'function') return fn;
    return (req, res) => res.status(501).json({
        success: false,
        message: `${fn?.name || 'Handler'} not implemented yet`,
    });
}

// ─────────────────────────────────────────────────────────
// Church CRUD
// ─────────────────────────────────────────────────────────

router.post('/', protect, safe(c.createChurch));
router.post('/join', protect, safe(c.joinByCode));
router.get('/:churchId', protect, safe(c.getChurch));
router.patch('/:churchId', protect, safe(c.updateChurch));
router.delete('/:churchId', protect, safe(c.deleteChurch));

// ─────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────

router.get('/:churchId/dashboard', protect, safe(c.getDashboard));

// ─────────────────────────────────────────────────────────
// Members
// ORDER MATTERS:
//   1. Static paths first  (/members/flagged, /members/create)
//   2. Parameterised paths last (/members/:membershipId)
// Without this order Express matches 'flagged' and 'create'
// as the :membershipId parameter value.
// ─────────────────────────────────────────────────────────

router.get(
    '/:churchId/members',
    protect,
    safe(c.getMembers)
);

// Static — must be BEFORE /:membershipId
router.get(
    '/:churchId/members/flagged',
    protect,
    safe(c.getFlaggedMembers)
);

// Static — must be BEFORE /:membershipId
router.post(
    '/:churchId/members/create',
    protect,
    requireChurchRole('admin', 'pastor'),
    c.createMemberByAdmin
);

// Parameterised — AFTER all static member routes
router.get(
    '/:churchId/members/:membershipId',
    protect,
    safe(c.getMember)
);

router.patch(
    '/:churchId/members/:membershipId/approve',
    protect,
    requireChurchRole('admin', 'pastor'),
    safe(c.approveMember)
);

router.patch(
    '/:churchId/members/:membershipId/status',
    protect,
    requireChurchRole('admin', 'pastor'),
    safe(c.setMemberStatus)
);

router.patch(
    '/:churchId/members/:membershipId',
    protect,
    requireChurchRole('admin', 'pastor'),
    safe(c.updateMember)
);

// ─────────────────────────────────────────────────────────
// Attendance
// ─────────────────────────────────────────────────────────

router.post('/:churchId/sessions', protect, safe(c.openSession));
router.get('/:churchId/sessions', protect, safe(c.getSessions));
router.get('/:churchId/sessions/:sid', protect, safe(c.getSession));
router.patch('/:churchId/sessions/:sid', protect, safe(c.closeSession));
router.post('/:churchId/sessions/checkin/qr', protect, safe(c.qrCheckIn));
router.get('/:churchId/sessions/:sid/report', protect, safe(c.getSessionReport));
router.get('/:churchId/attendance/trend', protect, safe(c.getAttendanceTrend));

// ─────────────────────────────────────────────────────────
// Giving
// ─────────────────────────────────────────────────────────

router.post('/:churchId/giving', protect, safe(c.recordGiving));
router.get('/:churchId/giving', protect, safe(c.getChurchGiving));
router.get('/:churchId/giving/me', protect, safe(c.getMyGiving));

// Webhook — no auth, raw body
router.post(
    '/:churchId/giving/webhook',
    express.raw({ type: 'application/json' }),
    safe(c.verifyPayment)
);

// ─────────────────────────────────────────────────────────
// Sermons
// ─────────────────────────────────────────────────────────

router.post(
    '/:churchId/sermons',
    protect,
    requireChurchRole('admin', 'pastor'),
    upload.single('file'),
    safe(c.createSermon)
);

router.get('/:churchId/sermons', protect, safe(c.getSermons));
router.get('/:churchId/sermons/:sid', protect, safe(c.getSermon));
router.patch('/:churchId/sermons/:sid', protect, requireChurchRole('admin', 'pastor'), safe(c.updateSermon));
router.delete('/:churchId/sermons/:sid', protect, requireChurchRole('admin', 'pastor'), safe(c.deleteSermon));

// ─────────────────────────────────────────────────────────
// Prayer requests
// ─────────────────────────────────────────────────────────

router.post('/:churchId/prayer', protect, safe(c.createPrayerRequest));
router.get('/:churchId/prayer', protect, safe(c.getPrayerRequests));
router.get('/:churchId/prayer/:pid', protect, safe(c.getPrayerRequest));
router.delete('/:churchId/prayer/:pid', protect, safe(c.deletePrayerRequest));
router.patch('/:churchId/prayer/:pid/pray', protect, safe(c.prayForRequest));
router.patch('/:churchId/prayer/:pid/answered', protect, safe(c.markAnswered));

// ─────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────

router.post('/:churchId/events', protect, requireChurchRole('admin', 'pastor'), safe(c.createEvent));
router.get('/:churchId/events', protect, safe(c.getEvents));
router.get('/:churchId/events/:eid', protect, safe(c.getEvent));
router.patch('/:churchId/events/:eid', protect, requireChurchRole('admin', 'pastor'), safe(c.updateEvent));
router.patch('/:churchId/events/:eid/cancel', protect, requireChurchRole('admin', 'pastor'), safe(c.cancelEvent));
router.post('/:churchId/events/:eid/rsvp', protect, safe(c.rsvp));

// ─────────────────────────────────────────────────────────
// Announcements
// ─────────────────────────────────────────────────────────

router.post('/:churchId/announcements', protect, requireChurchRole('admin', 'pastor'), safe(c.createAnnouncement));
router.get('/:churchId/announcements', protect, safe(c.getAnnouncements));
router.get('/:churchId/announcements/:aid', protect, safe(c.getAnnouncement));
router.patch('/:churchId/announcements/:aid', protect, requireChurchRole('admin', 'pastor'), safe(c.updateAnnouncement));
router.delete('/:churchId/announcements/:aid', protect, requireChurchRole('admin', 'pastor'), safe(c.deleteAnnouncement));

module.exports = router;