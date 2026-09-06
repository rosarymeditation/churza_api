const User = require("../models/User");
const upload = require("../middleware/upload"); // multer already set up
const { rootUrl } = require("../utils/constants");

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
    verifyResetCode,
    uploadPhoto,
    submitFeedback,
    getNotificationPreferences,
    updateNotificationPreferences,
} = require("../controllers/userController");

const { protect, restrictTo, optionalAuth } = require("../middleware/auth");

module.exports = (app) => {
    // ── Public routes — no token required ───────────────────
    app.post(rootUrl("/auth/register"), register);
    app.post(rootUrl("/auth/login"), login);
    app.post(rootUrl("/auth/forgot-password"), forgotPassword);
    app.post(rootUrl("/auth/reset-password/:token"), resetPassword);

    // ── Authenticated routes — valid JWT required ───────────
    app.post(rootUrl("/auth/logout"), protect, logout);
    app.post(rootUrl("/auth/change-password"), protect, changePassword);

    app.get(rootUrl("/users/me"), protect, getMe);
    app.patch(rootUrl("/users/me"), protect, updateMe);
    app.delete(rootUrl("/users/me"), protect, deleteMe);
    app.patch(rootUrl("/users/me/push-token"), protect, updatePushToken);
    app.get(rootUrl("/users/me/notifications"), protect, getMyNotifications);
    app.patch(rootUrl("/users/me/notification-preferences"), protect, updateNotificationPreferences);
    app.get(rootUrl("/users/me/notification-preferences"), protect, getNotificationPreferences);

    // ── Super admin only routes ──────────────────────────────
    app.get(rootUrl("/users"), protect, restrictTo("super_admin"), getAllUsers);
    app.get(rootUrl("/users/:id"), protect, restrictTo("super_admin"), getUserById);
    app.patch(rootUrl("/users/:id/status"), protect, restrictTo("super_admin"), setUserStatus);

    app.post(rootUrl("/forgot-password"), protect, forgotPassword);
    app.post(rootUrl("/reset-password"), protect, resetPassword);
    app.post(rootUrl("/verify-reset-code"), protect, verifyResetCode);
    app.post(rootUrl("/users/me/photo"), protect, upload.single("photo"), uploadPhoto);
    app.post(rootUrl("/support/feedback"), protect, optionalAuth, submitFeedback);

    app.patch(rootUrl("/users/push-token"), protect, async (req, res) => {
        try {
            const { pushToken } = req.body;
            if (!pushToken) {
                return res.status(400).json({
                    success: false,
                    message: "Push token is required",
                });
            }
            await User.findByIdAndUpdate(req.user._id, { pushToken });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
};