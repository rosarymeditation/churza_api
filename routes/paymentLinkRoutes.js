// const controller = require("../controllers/paymentLinkController");
// const { rootUrl } = require("../utils/constants");
// const { protect, requireStripeOnboarding } = require("../middleware/auth");

// module.exports = (app) => {
//     // PUBLIC — tenant opens this in a browser (no login needed)
//     app.get(rootUrl("/:shortCode/pay"), controller.openPaymentLink);

//     // PROTECTED — landlord manages links
//     app.get(rootUrl("/"), protect, controller.getPaymentLinks);
//     app.post(rootUrl("/"), protect, requireStripeOnboarding, controller.createPaymentLink);
//     app.post(rootUrl("/:id/share"), protect, controller.sharePaymentLink);
//     app.delete(rootUrl("/:id"), protect, controller.cancelPaymentLink);
// };