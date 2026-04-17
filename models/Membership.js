const mongoose = require('mongoose');

/**
 * Membership
 * ─────────────────────────────────────────────────────────
 * Joins a User to a Church. One user can belong to multiple
 * churches (e.g. someone who transfers). Each membership
 * carries its own role, status, and spiritual journey data.
 */
const membershipSchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },

    // Role within the church
    role: {
      type: String,
      enum: ['member', 'worker', 'cell_leader', 'deacon', 'pastor', 'admin', 'super_admin'],
      default: 'member',
    },

    // Membership lifecycle
    status: {
      type: String,
      enum: ['pending', 'active', 'inactive', 'suspended'],
      default: 'pending',
      index: true,
    },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: Date.now },
    membershipNumber: { type: String, trim: true },

    // Spiritual journey milestones
    milestones: {
      newConvert: { type: Boolean, default: false },
      newConvertDate: { type: Date },
      foundationClassCompleted: { type: Boolean, default: false },
      foundationClassDate: { type: Date },
      waterBaptized: { type: Boolean, default: false },
      waterBaptismDate: { type: Date },
      holyGhostBaptized: { type: Boolean, default: false },
      holyGhostBaptismDate: { type: Date },
    },

    // Cell group assignment
    cellGroup: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CellGroup',
      default: null,
    },

    // Department / ministry assignment (e.g. choir, ushers)
    department: { type: String, trim: true },

    // Absentee tracking — updated by a background job after each service
    consecutiveAbsences: { type: Number, default: 0 },
    lastAttendedAt: { type: Date },
    isFlagged: { type: Boolean, default: false, index: true },
    flaggedAt: { type: Date },

    emergencyContact: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      relationship: { type: String, trim: true },
    },

    notes: { type: String, trim: true }, // private pastoral notes
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// A user can only have one membership record per church
membershipSchema.index({ user: 1, church: 1 }, { unique: true });

// Used by dashboard: all active flagged members in a church
membershipSchema.index({ church: 1, isFlagged: 1, status: 1 });

membershipSchema.virtual('isAdmin').get(function () {
  return ['admin', 'super_admin', 'pastor'].includes(this.role);
});

module.exports = mongoose.model('Membership', membershipSchema);
