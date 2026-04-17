/**
 * rentflow/routes/tenantRoutes.js
 * Mounted at: /api/tenants
 */
const express = require("express");
const router = express.Router();
const tc = require("../controllers/tenantController");
const { protect } = require("../middleware/auth");

router.use(protect);

// Specific routes MUST come before /:id to avoid conflicts
router.get("/overdue", tc.getOverdueTenants);
router.get("/expiring-leases", tc.getExpiringLeases);

router.get("/", tc.getTenants);
router.post("/", tc.createTenant);
router.get("/:id", tc.getTenant);
router.patch("/:id", tc.updateTenant);
router.post("/:id/move-out", tc.moveOut);

module.exports = router;