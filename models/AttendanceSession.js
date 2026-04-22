const mongoose = require('mongoose');

// Represents a single service check-in window
// Admin starts it, members check in during it
const sessionSchema = new mongoose.Schema({
    church: { type: mongoose.Schema.Types.ObjectId, ref: 'Church', required: true },
    title: { type: String, default: 'Sunday Service' },
    serviceType: { type: String, enum: ['sunday', 'midweek', 'prayer', 'special', 'other'], default: 'sunday' },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    attendeeCount: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('AttendanceSession', sessionSchema);