const controller = require("../controllers/liveController");
const { rootUrl } = require("../utils/constants");
const { protect, requireChurchRole, requireActiveMembership } = require("../middleware/auth");

// FIX: same bug as churchRoutes.js - this file used to be mounted under
// app.use('/api/churches', liveRoutes) so the /churches prefix came from
// the mount point, not from these paths. Converting to the (app)=>{}
// pattern dropped that prefix. Every path below now includes /churches
// explicitly, matching what the Flutter app's ChurzaApi.live()/liveById()
// constants actually request.
module.exports = (app) => {
    app.get(rootUrl("/churches/:churchId/live"), protect, requireActiveMembership, controller.getCurrentLive);
    app.post(rootUrl("/churches/:churchId/live"), protect, requireChurchRole("admin", "pastor"), controller.startLive);
    app.patch(rootUrl("/churches/:churchId/live/:sessionId"), protect, requireChurchRole("admin", "pastor"), controller.endLive);
    app.patch(rootUrl("/churches/:churchId/live/:sessionId/join"), protect, requireActiveMembership, controller.joinLive);
    app.get(rootUrl("/churches/:churchId/live/history"), protect, requireActiveMembership, controller.getLiveHistory);
};