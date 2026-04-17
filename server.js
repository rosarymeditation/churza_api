require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const churchRoutes = require('./routes/churchRoutes');
const liveRoutes = require('./routes/liveRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const userRoutes = require('./routes/userRoutes');
const http = require('http');
const { initSocket } = require('./utils/socketHandler');
const chatRoutes = require('./routes/chatRoutes');
const errorHandler = require('./middleware/errorHandler');

require('./models');

const app = express();

// ── Security ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

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

// ── Stripe webhook — MUST be before express.json() ────────
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
app.use('/api/churches', churchRoutes);   // handles /api/churches/*
app.use('/api/churches', liveRoutes);     // shares /api/churches — handles /api/churches/:churchId/live/*
app.use('/api/payments', paymentRoutes);  // handles /api/payments/*
app.use('/api/chat', chatRoutes);

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) =>
  res.status(200).json({ success: true, message: 'ChurchConnect API is running' })
);

// ── 404 ───────────────────────────────────────────────────
app.all('*', (req, res) =>
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` })
);

// ── Error handler — must be last ──────────────────────────
app.use(errorHandler);

// ── Database + server ─────────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected');
    // app.listen(PORT, () =>
    //   console.log(`ChurchConnect API running on port ${PORT} [${process.env.NODE_ENV}]`)
    // );
    const httpServer = http.createServer(app);
    initSocket(httpServer);
    httpServer.listen(PORT, () =>
      console.log(`ChurchConnect API running on port ${PORT}`)
    );
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });

module.exports = app;