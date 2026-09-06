const controller = require("../controllers/churchController");
const { rootUrl } = require("../utils/constants");
const { protect } = require("../middleware/auth");

module.exports = (app) => {
    app.get(rootUrl("/"), protect, controller.getDashboard);
};