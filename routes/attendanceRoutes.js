const controller = require("../controllers/attendanceController");
const { rootUrl } = require("../utils/constants");
const { protect, requireChurchRole, requireActiveMembership } = require("../middleware/auth");

module.exports = (app) => {
    // Member routes
    app.get(rootUrl("/me/today"), protect, requireActiveMembership, controller.getMyAttendanceToday);
    app.get(rootUrl("/session"), protect, requireActiveMembership, controller.getActiveSession);
    app.post(rootUrl("/checkin"), protect, requireActiveMembership, controller.checkIn);

    // Admin / pastor routes
    app.post(rootUrl("/start"), protect, requireChurchRole("admin", "pastor"), controller.startSession);
    app.post(rootUrl("/end"), protect, requireChurchRole("admin", "pastor"), controller.endSession);
    app.post(rootUrl("/usher"), protect, requireChurchRole("admin", "pastor", "cell_leader"), controller.usherCheckIn);
    app.get(rootUrl("/"), protect, requireChurchRole("admin", "pastor"), controller.getReport);
    app.get(rootUrl("/sessions"), protect, requireChurchRole("admin", "pastor"), controller.getSessions);
};