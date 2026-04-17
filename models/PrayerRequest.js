const mongoose = require('mongoose');

const prayerRequestSchema = new mongoose.Schema(
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

    // ── Content ──────────────────────────────────────────
    title: {
      type: String,
      required: [true, 'Prayer title is required'],
      trim: true,
      maxlength: 200,
    },
    body: {
      type: String,
      trim: true,
      maxlength: 2000,
    },

    // ── Classification ───────────────────────────────────
    category: {
      type: String,
      enum: [
        'general',
        'healing',
        'family',
        'finances',
        'salvation',
        'guidance',
        'thanksgiving',
        'protection',
      ],
      default: 'general',
    },

    // ── Privacy ──────────────────────────────────────────
    isAnonymous: { type: Boolean, default: false },
    isPublic: { type: Boolean, default: true },

    // ── Status ───────────────────────────────────────────
    status: {
      type: String,
      enum: ['open', 'answered'],
      default: 'open',
      index: true,
    },
    answeredAt: { type: Date },
    testimony: { type: String, trim: true, maxlength: 1000 },

    // ── Engagement ───────────────────────────────────────
    // prayedBy stores user IDs to prevent duplicate prayers
    prayedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    // prayerCount is denormalised from prayedBy.length for fast reads
    prayerCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Fast queries for church prayer wall
prayerRequestSchema.index({ church: 1, status: 1, createdAt: -1 });
prayerRequestSchema.index({ church: 1, category: 1 });

module.exports = mongoose.model('PrayerRequest', prayerRequestSchema);