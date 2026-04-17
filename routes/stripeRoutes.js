/**
 * rentflow/routes/stripeRoutes.js
 * Mounted at: /api/stripe
 */
const express = require("express");
const router = express.Router();
const sc = require("../controllers/stripeController");
const { protect } = require("../middleware/auth");

router.post("/connect", protect, sc.connectStripe);
router.get("/status", protect, sc.getStripeStatus);

module.exports = router;