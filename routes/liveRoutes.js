const controller = require("../controllers/liveController");
const { rootUrl } = require("../utils/constants");
const { protect, requireChurchRole, requireActiveMembership } = require("../middleware/auth");

module.exports = (app) => {
    app.get(rootUrl("/:churchId/live"), protect, requireActiveMembership, controller.getCurrentLive);
    app.post(rootUrl("/:churchId/live"), protect, requireChurchRole("admin", "pastor"), controller.startLive);
    app.patch(rootUrl("/:churchId/live/:sessionId"), protect, requireChurchRole("admin", "pastor"), controller.endLive);
    app.patch(rootUrl("/:churchId/live/:sessionId/join"), protect, requireActiveMembership, controller.joinLive);
    app.get(rootUrl("/:churchId/live/history"), protect, requireActiveMembership, controller.getLiveHistory);
};