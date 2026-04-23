require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const http = require('http');
const cron = require('node-cron');

const churchRoutes = require('./routes/churchRoutes');
const liveRoutes = require('./routes/liveRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const userRoutes = require('./routes/userRoutes');
const chatRoutes = require('./routes/chatRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');

const { initSocket } = require('./utils/socketHandler');
const errorHandler = require('./middleware/errorHandler');
const {
  eventReminderCron,
  giftAidReminderCron,
} = require('./utils/churchNotifications');

require('./models');

const app = express();

// ── Security ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ─────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please try again later' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes' },
});

app.use('/api', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

// ── Stripe webhook — MUST be before express.json() ───────
// Stripe sends a raw body — express.json() would break
// the signature verification if it parses the body first.
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  require('./controllers/paymentController').handleWebhook
);

// ── Body parsing ──────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Routes ────────────────────────────────────────────────
app.use('/api', userRoutes);
app.use('/api/churches', churchRoutes);    // /api/churches/*
app.use('/api/churches', liveRoutes);      // /api/churches/:churchId/live/*
app.use('/api/payments', paymentRoutes);   // /api/payments/*
app.use('/api/chat', chatRoutes);      // /api/chat/*
app.use('/api/churches/:churchId/attendance', attendanceRoutes);

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) =>
  res.status(200).json({ success: true, message: 'Churza API is running' })
);

// ── 404 ───────────────────────────────────────────────────
app.all('*', (req, res) =>
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  })
);

// ── Error handler — must be last ──────────────────────────
app.use(errorHandler);

// ── Database + server ─────────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected');

    const httpServer = http.createServer(app);
    initSocket(httpServer);

    httpServer.listen(PORT, () => {
      console.log(`✅ Churza API running on port ${PORT} [${process.env.NODE_ENV}]`);

      // ── Cron jobs ──────────────────────────────────────
      // Started inside listen callback so MongoDB is
      // guaranteed connected before any cron query runs.

      // Event reminders — runs every day at 09:00 UTC.
      // Finds events starting in the next 24 hours and
      // sends a push notification to everyone who RSVPed.
      cron.schedule('0 9 * * *', async () => {
        console.log('⏰ Cron: running event reminder...');
        try {
          await eventReminderCron();
          console.log('✅ Cron: event reminder complete');
        } catch (err) {
          console.error('❌ Cron: event reminder failed:', err.message);
        }
      }, { timezone: 'UTC' });

      // Gift Aid reminder — runs once a year on 1st April at 09:00 UTC.
      // UK tax year ends 5th April — reminds members of all GBP churches
      // to enable Gift Aid before the year closes.
      cron.schedule('0 9 1 4 *', async () => {
        console.log('⏰ Cron: running Gift Aid reminder...');
        try {
          await giftAidReminderCron();
          console.log('✅ Cron: Gift Aid reminder complete');
        } catch (err) {
          console.error('❌ Cron: Gift Aid reminder failed:', err.message);
        }
      }, { timezone: 'UTC' });

      console.log('⏰ Cron jobs scheduled:');
      console.log('   → Event reminders:   daily at 09:00 UTC');
      console.log('   → Gift Aid reminder: 1st April at 09:00 UTC');
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

module.exports = app;