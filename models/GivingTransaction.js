const mongoose = require('mongoose');

const givingTransactionSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // ── Amount ────────────────────────────────────────────
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'GBP',
      uppercase: true,
    },

    // ── Classification ────────────────────────────────────
    type: {
      type: String,
      enum: ['tithe', 'offering', 'pledge', 'special', 'cash'],
      default: 'offering',
      index: true,
    },

    // ── Payment method ────────────────────────────────────
    method: {
      type: String,
      enum: ['stripe', 'paystack', 'cash', 'bank_transfer'],
      default: 'stripe',
    },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },

    // ── References ────────────────────────────────────────
    reference: { type: String, unique: true, sparse: true }, // Stripe PaymentIntent ID
    note: { type: String, trim: true },

    // ── For cash — who recorded it ────────────────────────
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    processedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Fast queries for giving overview
givingTransactionSchema.index({ church: 1, status: 1, processedAt: -1 });
givingTransactionSchema.index({ church: 1, user: 1, status: 1 });
givingTransactionSchema.index({ church: 1, type: 1, processedAt: -1 });

module.exports = mongoose.model('GivingTransaction', givingTransactionSchema);