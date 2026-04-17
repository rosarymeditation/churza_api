const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: 150,
    },
    body: {
      type: String,
      required: [true, 'Body is required'],
      trim: true,
      maxlength: 3000,
    },
    imageUrl: { type: String },
    audience: {
      type: String,
      enum: ['all', 'members', 'leaders'],
      default: 'all',
    },
    isPinned: { type: Boolean, default: false },
    expiresAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

announcementSchema.index({ church: 1, isPinned: -1, createdAt: -1 });

module.exports = mongoose.model('Announcement', announcementSchema);