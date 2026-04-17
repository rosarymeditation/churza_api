const mongoose = require('mongoose');

/**
 * Notification
 * ─────────────────────────────────────────────────────────
 * Persisted in-app notification for a specific user.
 * Push delivery is handled by a separate service (FCM/APNs).
 * This model is the inbox — what the user sees in the app.
 */
const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      default: null,
    },

    type: {
      type: String,
      required: true,
      enum: [
        'announcement',
        'sermon_published',
        'event_reminder',
        'prayer_reply',
        'giving_receipt',
        'attendance_flagged',     // admin: member flagged absent
        'member_joined',          // admin: new member joined
        'membership_approved',    // member: your request was approved
        'pledge_reminder',
        'system',
      ],
      index: true,
    },

    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },

    // Deep-link data — the app uses this to navigate on tap
    data: { type: mongoose.Schema.Types.Mixed },
    // e.g. { screen: 'Sermon', sermonId: '...' }
    // e.g. { screen: 'Event', eventId: '...' }

    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
