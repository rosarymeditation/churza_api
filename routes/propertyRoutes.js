/**
 * rentflow/routes/propertyRoutes.js
 * Mounted at: /api/properties
 */
const express = require("express");
const router = express.Router();
const pc = require("../controllers/propertyController");
const { protect } = require("../middleware/auth");

router.use(protect); // All routes require login

router.get("/", pc.getProperties);
router.post("/", pc.createProperty);
router.get("/:id", pc.getProperty);
router.patch("/:id", pc.updateProperty);
router.delete("/:id", pc.deleteProperty);
router.post("/:id/units", pc.addUnit);
router.patch("/:id/units/:unitId", pc.updateUnit);
router.delete("/:id/units/:unitId", pc.deleteUnit);

module.exports = router;