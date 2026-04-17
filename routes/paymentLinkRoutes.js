/**
 * rentflow/routes/paymentLinkRoutes.js
 * Mounted at: /api/payment-links
 */
const express = require("express");
const router = express.Router();
const plc = require("../controllers/paymentLinkController");
const { protect, requireStripeOnboarding } = require("../middleware/auth");

// PUBLIC — tenant opens this in a browser (no login needed)
router.get("/:shortCode/pay", plc.openPaymentLink);

// PROTECTED — landlord manages links
router.use(protect);
router.get("/", plc.getPaymentLinks);
router.post("/", requireStripeOnboarding, plc.createPaymentLink);
router.post("/:id/share", plc.sharePaymentLink);
router.delete("/:id", plc.cancelPaymentLink);

module.exports = router;