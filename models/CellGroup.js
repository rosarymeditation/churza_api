const mongoose = require('mongoose');

/**
 * CellGroup — A small group within a church.
 *
 * Think of this like a classroom in a school.
 * The church is the school, cell groups are classrooms,
 * the cell leader is the teacher, members are students.
 *
 * Each cell group has:
 * - A name (e.g. "North London Cell")
 * - A leader (a trusted church member)
 * - A list of members
 * - A meeting schedule
 * - A chat room (messages are in a separate collection)
 */
const cellGroupSchema = new mongoose.Schema(
  {
    // Which church this group belongs to
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },

    // Group display name
    name: {
      type: String,
      required: [true, 'Cell group name is required'],
      trim: true,
      maxlength: 100,
    },

    // Optional description — what this group focuses on
    description: { type: String, trim: true },

    // The cell leader — a church member with elevated access
    // They can take attendance and send group announcements
    leader: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // All members in this group (array of User IDs)
    // We store IDs here for fast "who is in this group" lookups
    members: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],

    // When and where the group meets
    meetingDay: { type: String }, // e.g. "Thursday"
    meetingTime: { type: String }, // e.g. "7:00 PM"
    meetingLocation: { type: String }, // e.g. "42 Victoria Road, N4"

    // Whether this group is currently active
    isActive: { type: Boolean, default: true },

    // Thumbnail colour for the UI card (hex)
    colour: { type: String, default: '#C9A84C' },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual — how many members are in this group
// A virtual is a computed field that is not stored in the DB
// It is calculated on the fly when you read the document
cellGroupSchema.virtual('memberCount').get(function () {
  return this.members ? this.members.length : 0;
});

// Index for fast queries — "get all groups for this church"
cellGroupSchema.index({ church: 1, isActive: 1 });

module.exports = mongoose.model('CellGroup', cellGroupSchema);