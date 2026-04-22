/**
 * ChurchConnect — Mongoose Models
 * ─────────────────────────────────────────────────────────
 * Central export. Import from here in routes/services:
 *
 *   const { Church, Membership, AttendanceRecord } = require('./models');
 */

const Attendance = require('./Attendance');
const AttendanceSession = require('./AttendanceSession');

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
  AttendanceSession: require('./AttendanceSession'),
  Attendance: require('./Attendance'),
};
