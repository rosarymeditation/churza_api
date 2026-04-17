const mongoose = require('mongoose');

const sermonSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    title: {
      type: String,
      required: [true, 'Sermon title is required'],
      trim: true,
    },
    description: { type: String, trim: true },
    speaker: { type: String, trim: true },
    seriesName: { type: String, trim: true },

    // Media
    mediaType: {
      type: String,
      enum: ['audio', 'video', 'link', 'both'],
      required: true,
    },
    audioUrl: { type: String },
    videoUrl: { type: String },
    thumbnailUrl: { type: String },
    fileSize: { type: Number },        // bytes — for audio files
    mimeType: { type: String },        // 'audio/mpeg', 'audio/mp4' etc
    durationSeconds: { type: Number },

    // Discovery
    tags: [{ type: String, lowercase: true, trim: true }],
    bibleReferences: [{ type: String, trim: true }], // e.g. ["John 3:16", "Romans 8:28"]

    // Publishing
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'published'],
      default: 'draft',
      index: true,
    },
    publishedAt: { type: Date },
    scheduledFor: { type: Date },

    // Engagement (lightweight counters — no separate collection for MVP)
    views: { type: Number, default: 0 },
    downloads: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

sermonSchema.virtual('isPublished').get(function () {
  return this.status === 'published' && this.publishedAt <= new Date();
});

sermonSchema.virtual('duration').get(function () {
  if (!this.durationSeconds) return null;
  const m = Math.floor(this.durationSeconds / 60);
  const s = this.durationSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
});

sermonSchema.index({ church: 1, status: 1, publishedAt: -1 });
sermonSchema.index({ church: 1, tags: 1 });

module.exports = mongoose.model('Sermon', sermonSchema);
