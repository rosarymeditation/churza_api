const controller = require("../controllers/paymentController");
const { rootUrl } = require("../utils/constants");
const { protect, requireChurchRole, requireActiveMembership } = require("../middleware/auth");
const express = require("express");

module.exports = (app) => {
    // Stripe webhook — no auth, raw body (see warning below)
    app.post(
        rootUrl("/webhook"),
        express.raw({ type: "application/json" }),
        controller.handleWebhook
    );

    // Stripe Connect — admin onboards their church
    app.post(rootUrl("/:churchId/connect"), protect, requireChurchRole("admin"), controller.connectStripe);
    app.get(rootUrl("/:churchId/connect/status"), protect, requireChurchRole("admin", "pastor"), controller.connectStatus);
    app.delete(rootUrl("/:churchId/connect"), protect, requireChurchRole("admin"), controller.disconnectStripe);

    // Member giving — create intent and confirm
    app.post(rootUrl("/:churchId/intent"), protect, requireActiveMembership, controller.createPaymentIntent);
    app.post(rootUrl("/:churchId/confirm"), protect, requireActiveMembership, controller.confirmPayment);
    app.get(rootUrl("/:churchId/history/me"), protect, requireActiveMembership, controller.myGivingHistory);

    // Admin — giving management
    app.get(rootUrl("/:churchId/overview"), protect, requireChurchRole("admin", "pastor"), controller.givingOverview);
    app.get(rootUrl("/:churchId/transactions"), protect, requireChurchRole("admin", "pastor"), controller.allTransactions);
    app.post(rootUrl("/:churchId/cash"), protect, requireChurchRole("admin", "pastor", "worker"), controller.recordCash);
};