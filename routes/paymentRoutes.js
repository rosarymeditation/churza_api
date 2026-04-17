const express = require('express');
const router = express.Router();
const {
    protect,
    requireChurchRole,
    requireActiveMembership,
} = require('../middleware/auth');
const c = require('../controllers/paymentController');

// ─────────────────────────────────────────────────────────
// Stripe webhook — no auth, raw body
// Must be registered BEFORE express.json() middleware
// Mount this in server.js BEFORE app.use(express.json())
// ─────────────────────────────────────────────────────────
router.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    c.handleWebhook
);

// ─────────────────────────────────────────────────────────
// Stripe Connect — admin onboards their church
// ─────────────────────────────────────────────────────────
router.post(
    '/:churchId/connect',
    protect,
    requireChurchRole('admin'),
    c.connectStripe
);

router.get(
    '/:churchId/connect/status',
    protect,
    requireChurchRole('admin', 'pastor'),
    c.connectStatus
);

router.delete(
    '/:churchId/connect',
    protect,
    requireChurchRole('admin'),
    c.disconnectStripe
);

// ─────────────────────────────────────────────────────────
// Member giving — create intent and confirm
// ─────────────────────────────────────────────────────────
router.post(
    '/:churchId/intent',
    protect,
    requireActiveMembership,
    c.createPaymentIntent
);

router.post(
    '/:churchId/confirm',
    protect,
    requireActiveMembership,
    c.confirmPayment
);

router.get(
    '/:churchId/history/me',
    protect,
    requireActiveMembership,
    c.myGivingHistory
);

// ─────────────────────────────────────────────────────────
// Admin — giving management
// ─────────────────────────────────────────────────────────
router.get(
    '/:churchId/overview',
    protect,
    requireChurchRole('admin', 'pastor'),
    c.givingOverview
);

router.get(
    '/:churchId/transactions',
    protect,
    requireChurchRole('admin', 'pastor'),
    c.allTransactions
);

router.post(
    '/:churchId/cash',
    protect,
    requireChurchRole('admin', 'pastor', 'worker'),
    c.recordCash
);

module.exports = router;