const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },
    organiser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Event title is required'],
      trim: true,
      maxlength: 150,
    },
    description: { type: String, trim: true, maxlength: 2000 },
    location: { type: String, trim: true },
    imageUrl: { type: String },

    // ── Schedule ─────────────────────────────────────────
    startsAt: { type: Date, required: [true, 'Start date is required'] },
    endsAt: { type: Date },

    // ── Status ───────────────────────────────────────────
    status: {
      type: String,
      enum: ['upcoming', 'ongoing', 'completed', 'cancelled'],
      default: 'upcoming',
      index: true,
    },
    cancelledAt: { type: Date },
    cancellationNote: { type: String },

    // ── Visibility ───────────────────────────────────────
    isPublic: { type: Boolean, default: true },

    // ── RSVP ─────────────────────────────────────────────
    rsvpList: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    rsvpCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

eventSchema.index({ church: 1, status: 1, startsAt: 1 });

module.exports = mongoose.model('Event', eventSchema);