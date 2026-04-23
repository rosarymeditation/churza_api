const express = require('express');
const router = express.Router({ mergeParams: true });
const ctrl = require('../controllers/attendanceController');
const { protect, requireChurchRole, requireActiveMembership } =
    require('../middleware/auth');

// Member routes
router.get('/me/today', protect, requireActiveMembership,
    ctrl.getMyAttendanceToday);
router.get('/session', protect, requireActiveMembership, ctrl.getActiveSession);
router.post('/checkin', protect, requireActiveMembership, ctrl.checkIn);

// Admin / pastor routes
router.post('/start', protect, requireChurchRole('admin', 'pastor'), ctrl.startSession);
router.post('/end', protect, requireChurchRole('admin', 'pastor'), ctrl.endSession);
router.post('/usher', protect, requireChurchRole('admin', 'pastor', 'cell_leader'), ctrl.usherCheckIn);
router.get('/', protect, requireChurchRole('admin', 'pastor'), ctrl.getReport);
router.get('/sessions', protect, requireChurchRole('admin', 'pastor'), ctrl.getSessions);

module.exports = router;