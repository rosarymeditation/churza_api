/**
 * rentflow/routes/webhookRoutes.js
 * Mounted at: /api/webhooks
 *
 * IMPORTANT: This must be mounted in server.js BEFORE express.json()
 * Stripe requires the raw body to verify webhook signatures
 */
const express = require("express");
const router = express.Router();
const wc = require("../controllers/webhookController");

// express.raw() preserves the raw body that Stripe needs to verify the signature
router.post("/stripe", express.raw({ type: "application/json" }), wc.handleStripeWebhook);

module.exports = router;