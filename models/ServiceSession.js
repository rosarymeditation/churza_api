const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * ServiceSession
 * ─────────────────────────────────────────────────────────
 * Represents a single church service or event that members
 * can be marked present/absent against. The QR code is
 * generated here and tied to this session.
 */
const serviceSessionSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    title: {
      type: String,
      required: [true, 'Session title is required'],
      trim: true,
      // e.g. "Sunday First Service", "Midweek Service", "Annual Convention Day 1"
    },
    type: {
      type: String,
      enum: ['sunday_service', 'midweek', 'prayer_meeting', 'event', 'special'],
      default: 'sunday_service',
    },

    scheduledAt: {
      type: Date,
      required: true,
    },

    // QR check-in
    qrToken: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      // Generated on open, invalidated on close
    },
    qrExpiresAt: { type: Date },

    status: {
      type: String,
      enum: ['scheduled', 'open', 'closed'],
      default: 'scheduled',
      index: true,
    },
    openedAt: { type: Date },
    closedAt: { type: Date },

    // Snapshot counts — computed when session is closed
    totalExpected: { type: Number, default: 0 },
    totalPresent: { type: Number, default: 0 },
    totalAbsent: { type: Number, default: 0 },
    totalLate: { type: Number, default: 0 },

    notes: { type: String, trim: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

serviceSessionSchema.virtual('attendanceRate').get(function () {
  if (!this.totalExpected) return 0;
  return Math.round((this.totalPresent / this.totalExpected) * 100);
});

serviceSessionSchema.virtual('isOpen').get(function () {
  return this.status === 'open';
});

// Generate a fresh QR token and set 3-hour expiry
serviceSessionSchema.methods.openSession = function () {
  this.qrToken = crypto.randomBytes(20).toString('hex');
  this.qrExpiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
  this.status = 'open';
  this.openedAt = new Date();
};

serviceSessionSchema.methods.closeSession = function (summary = {}) {
  this.status = 'closed';
  this.closedAt = new Date();
  this.qrToken = undefined; // invalidate QR
  this.qrExpiresAt = undefined;
  if (summary.totalExpected !== undefined) this.totalExpected = summary.totalExpected;
  if (summary.totalPresent !== undefined) this.totalPresent = summary.totalPresent;
  if (summary.totalAbsent !== undefined) this.totalAbsent = summary.totalAbsent;
  if (summary.totalLate !== undefined) this.totalLate = summary.totalLate;
};

serviceSessionSchema.index({ church: 1, scheduledAt: -1 });

module.exports = mongoose.model('ServiceSession', serviceSessionSchema);
