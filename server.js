require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const http = require("http");
const cron = require("node-cron");
const { initSocket } = require("./utils/socketHandler");
const errorHandler = require("./middleware/errorHandler");
const {
  eventReminderCron,
  giftAidReminderCron,
} = require("./utils/churchNotifications");
require("./models");

const app = express();

// security
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// rate limits - general api + tighter one for auth so ppl cant brute force login
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: true, message: "Too many requests. Please try again later" },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: true, message: "Too many login attempts. Please try again in 15 minutes" },
});
app.use("/api", limiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);

// ─────────────────────────────────────────────────────────────────────────
// FIX: all three webhook-shaped endpoints in this project now live here,
// registered BEFORE express.json(). Each one needs the raw, unparsed
// request body to verify its signature (Stripe's constructEvent, and any
// HMAC check on the Paystack side) - if express.json() runs first, the
// body is already consumed/parsed and signature verification fails.
//
// Previously these were scattered inside individual route files that get
// require()'d AFTER express.json() runs in the normal route-loading
// sequence, which silently broke signature verification. Do not move
// these back into a route file loaded later - keep them here.
// ─────────────────────────────────────────────────────────────────────────
const paymentController = require("./controllers/paymentController");
const givingController = require("./controllers/givingController");

app.post(
  "/api/churches/:churchId/giving/webhook",
  express.raw({ type: "application/json" }),
  paymentController.handleWebhook
);

app.post(
  "/api/giving/webhook",
  express.raw({ type: "application/json" }),
  givingController.verifyPayment
);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// routes
require("./routes/userRoutes")(app);
require("./routes/churchRoutes")(app);
require("./routes/liveRoutes")(app);
require("./routes/chatRoutes")(app);

app.get("/health", (req, res) =>
  res.status(200).send({ error: false, message: "Churza API is running" })
);

// catch all 404
app.all("*", (req, res) =>
  res.status(404).send({
    error: true,
    message: `Route ${req.originalUrl} not found`,
  })
);

app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// FIX: this project's .env uses MONGODB_URI, not MONGO_URI - confirmed
// against the real .env you shared. If you ever rename the variable in
// .env, update this line to match, and vice versa.
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("mongo connected");

    const httpServer = http.createServer(app);
    initSocket(httpServer);

    httpServer.listen(PORT, () => {
      console.log(`churza api running on port ${PORT} [${process.env.NODE_ENV}]`);

      cron.schedule("0 9 * * *", async () => {
        console.log("cron: running event reminder");
        try {
          await eventReminderCron();
          console.log("cron: event reminder done");
        } catch (err) {
          console.log("cron: event reminder failed:", err.message);
        }
      }, { timezone: "UTC" });

      cron.schedule("0 9 1 4 *", async () => {
        console.log("cron: running gift aid reminder");
        try {
          await giftAidReminderCron();
          console.log("cron: gift aid reminder done");
        } catch (err) {
          console.log("cron: gift aid reminder failed:", err.message);
        }
      }, { timezone: "UTC" });

      console.log("cron jobs scheduled:");
      console.log("  event reminders - daily 9am utc");
      console.log("  gift aid reminder - apr 1st 9am utc");
    });
  })
  .catch((err) => {
    console.log("mongo connection failed:", err.message);
    process.exit(1);
  });

module.exports = app;