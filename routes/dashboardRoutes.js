/**
 * rentflow/routes/dashboardRoutes.js
 * Mounted at: /api/dashboard
 */
const express = require("express");
const router = express.Router();
const dc = require("../controllers/dashboardController");
const { protect } = require("../middleware/auth");

router.get("/", protect, dc.getDashboard);

module.exports = router;