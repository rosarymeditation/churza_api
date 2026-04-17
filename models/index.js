/**
 * ChurchConnect — Mongoose Models
 * ─────────────────────────────────────────────────────────
 * Central export. Import from here in routes/services:
 *
 *   const { Church, Membership, AttendanceRecord } = require('./models');
 */

module.exports = {
  Church:             require('./Church'),
  User:               require('./User'),
  Membership:         require('./Membership'),
  CellGroup:          require('./CellGroup'),
  ServiceSession:     require('./ServiceSession'),
  AttendanceRecord:   require('./AttendanceRecord'),
  Sermon:             require('./Sermon'),
  GivingTransaction:  require('./GivingTransaction'),
  Pledge:             require('./Pledge'),
  PrayerRequest:      require('./PrayerRequest'),
  Event:              require('./Event'),
  EventRsvp:          require('./EventRsvp'),
  Announcement:       require('./Announcement'),
  Notification:       require('./Notification'),
  ChatMessage:        require('./ChatMessage'),
};
