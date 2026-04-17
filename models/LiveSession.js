const mongoose = require('mongoose');

const liveSessionSchema = new mongoose.Schema(
    {
        church: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Church',
            required: true,
            index: true,
        },
        startedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },

        title: { type: String, required: true, trim: true },
        description: { type: String, trim: true },

        // ── YouTube ──────────────────────────────────────────
        youtubeUrl: { type: String, required: true },
        youtubeVideoId: { type: String },

        // ── Status ───────────────────────────────────────────
        status: {
            type: String,
            enum: ['live', 'ended'],
            default: 'live',
            index: true,
        },

        // ── Viewers ──────────────────────────────────────────
        viewerCount: { type: Number, default: 0 },
        viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

        // ── Timestamps ───────────────────────────────────────
        startedAt: { type: Date, default: Date.now },
        endedAt: { type: Date },

        // ── Auto-saved sermon ─────────────────────────────────
        sermonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sermon' },
        savedAsSermon: { type: Boolean, default: false },
        sermonSpeaker: { type: String },
        sermonSeriesName: { type: String },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// Only one live session per church at a time
liveSessionSchema.index(
    { church: 1, status: 1 },
    { unique: true, partialFilterExpression: { status: 'live' } }
);

module.exports = mongoose.model('LiveSession', liveSessionSchema);