const express = require('express');
const router = express.Router();
const {
    protect,
    requireChurchRole,
    requireActiveMembership,
} = require('../middleware/auth');
const c = require('../controllers/liveController');

// ── Get current live session ──────────────────────────────
// Members poll this to check if service is live
router.get(
    '/:churchId/live',
    protect,
    requireActiveMembership,
    c.getCurrentLive
);

// ── Start live session ────────────────────────────────────
router.post(
    '/:churchId/live',
    protect,
    requireChurchRole('admin', 'pastor'),
    c.startLive
);

// ── End live session ──────────────────────────────────────
router.patch(
    '/:churchId/live/:sessionId',
    protect,
    requireChurchRole('admin', 'pastor'),
    c.endLive
);

// ── Member joins ──────────────────────────────────────────
router.patch(
    '/:churchId/live/:sessionId/join',
    protect,
    requireActiveMembership,
    c.joinLive
);

// ── Past sessions ─────────────────────────────────────────
router.get(
    '/:churchId/live/history',
    protect,
    requireActiveMembership,
    c.getLiveHistory
);

module.exports = router;