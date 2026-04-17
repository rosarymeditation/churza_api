const mongoose = require('mongoose');

const eventRsvpSchema = new mongoose.Schema(
  {
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
    },
    membership: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Membership',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    status: {
      type: String,
      enum: ['going', 'not_going', 'maybe'],
      default: 'going',
    },

    // Set to true when they check in at the event venue
    checkedIn: { type: Boolean, default: false },
    checkedInAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

eventRsvpSchema.index({ event: 1, membership: 1 }, { unique: true });
eventRsvpSchema.index({ event: 1, status: 1 });

module.exports = mongoose.model('EventRsvp', eventRsvpSchema);
