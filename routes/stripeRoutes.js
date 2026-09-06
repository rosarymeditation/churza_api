const controller = require("../controllers/paymentController");
const { rootUrl } = require("../utils/constants");
const { protect } = require("../middleware/auth");

module.exports = (app) => {
    app.post(rootUrl("/connect"), protect, controller.connectStripe);
};