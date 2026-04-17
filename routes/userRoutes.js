const express = require('express');
const router = express.Router();

const {
    register,
    login,
    logout,
    forgotPassword,
    resetPassword,
    changePassword,
    getMe,
    updateMe,
    deleteMe,
    updatePushToken,
    getMyNotifications,
    getAllUsers,
    getUserById,
    setUserStatus,
} = require('../controllers/userController');

const {
    protect,
    restrictTo,
} = require('../middleware/auth');

// ─────────────────────────────────────────────────────────
// Public routes — no token required
// ─────────────────────────────────────────────────────────
router.post('/auth/register', register);
router.post('/auth/login', login);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/reset-password/:token', resetPassword);

// ─────────────────────────────────────────────────────────
// Authenticated routes — valid JWT required
// ─────────────────────────────────────────────────────────
router.use(protect); // all routes below require auth

router.post('/auth/logout', logout);
router.post('/auth/change-password', changePassword);

router.get('/users/me', getMe);
router.patch('/users/me', updateMe);
router.delete('/users/me', deleteMe);
router.patch('/users/me/push-token', updatePushToken);
router.get('/users/me/notifications', getMyNotifications);

// ─────────────────────────────────────────────────────────
// Super admin only routes
// ─────────────────────────────────────────────────────────
router.get('/users', restrictTo('super_admin'), getAllUsers);
router.get('/users/:id', restrictTo('super_admin'), getUserById);
router.patch('/users/:id/status', restrictTo('super_admin'), setUserStatus);

module.exports = router;