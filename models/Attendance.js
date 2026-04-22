const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  church: { type: mongoose.Schema.Types.ObjectId, ref: 'Church', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  membership: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership' },
  serviceDate: { type: Date, default: Date.now },
  serviceType: {
    type: String,
    enum: ['sunday', 'midweek', 'prayer', 'special', 'other'],
    default: 'sunday'
  },
  method: {
    type: String,
    enum: ['app', 'usher', 'qr'],
    default: 'app'
  },
  checkedInAt: { type: Date, default: Date.now },
  location: {
    lat: { type: Number },
    lng: { type: Number },
  },
}, { timestamps: true });

// One check-in per user per day per church
attendanceSchema.index(
  { church: 1, user: 1, serviceDate: 1 },
  { unique: true, partialFilterExpression: { serviceDate: { $exists: true } } }
);

module.exports = mongoose.model('Attendance', attendanceSchema);