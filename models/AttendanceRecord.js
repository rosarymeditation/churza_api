const mongoose = require('mongoose');

/**
 * AttendanceRecord
 * ─────────────────────────────────────────────────────────
 * One document per member per service session.
 * Created automatically for all active members when a
 * session is opened (status = 'absent' by default), then
 * updated to 'present' or 'late' via QR scan or manual mark.
 */
const attendanceRecordSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceSession',
      required: true,
      index: true,
    },
    membership: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Membership',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    status: {
      type: String,
      enum: ['present', 'absent', 'late', 'excused'],
      default: 'absent',
    },

    // How was this record updated?
    checkInMethod: {
      type: String,
      enum: ['qr_scan', 'manual', 'system'],
      default: 'system',
    },

    checkedInAt: { type: Date }, // null = not present
    markedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      // null = self QR scan; ObjectId = admin/usher who manually marked
    },

    // Optional usher note e.g. "Left early", "Arrived with family"
    note: { type: String, trim: true },
  },
  {
    timestamps: true,
  }
);

// One record per member per session — enforced at DB level
attendanceRecordSchema.index({ session: 1, membership: 1 }, { unique: true });

// Used by absentee flagging job
attendanceRecordSchema.index({ church: 1, membership: 1, createdAt: -1 });

// Used by per-session report: all records for a session
attendanceRecordSchema.index({ session: 1, status: 1 });

module.exports = mongoose.model('AttendanceRecord', attendanceRecordSchema);
