const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Notification = require('../models/Notification');

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Sign a JWT for the given user id.
 * Expires in 30 days by default.
 */
const signToken = (userId) =>
    jwt.sign({ id: userId }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    });

/**
 * Build and send the standard auth response:
 * { token, user: safeObject }
 */
const sendAuthResponse = (res, statusCode, user) => {
    const token = signToken(user._id);
    res.status(statusCode).json({
        success: true,
        token,
        user: user.toSafeObject(),
    });
};

/**
 * Wrap an async route handler so unhandled promise rejections
 * are forwarded to Express's next(err) error handler.
 * Avoids try/catch boilerplate in every controller function.
 */
const catchAsync = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Standard error response helper.
 */
const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

// ─────────────────────────────────────────────────────────
// Auth controllers
// ─────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 *
 * Creates a new user account.
 * The user is not yet linked to a church — that happens
 * separately via the membership/join-by-code flow.
 *
 * Body: { firstName, lastName, email, phone, password,
 *         userIntent: 'member' | 'admin' }
 *
 * userIntent is sent by the Flutter app based on the
 * "Who are you?" screen selection (S-02b). It is NOT
 * stored in the database — it is echoed back in the
 * response so the app knows which screen to route to
 * after registration without any extra API call.
 *
 * Response includes:
 *   nextScreen: 'join_church'     → member path  → S-06
 *               'register_church' → admin path   → S-07
 *   hasChurch: false              → always false on fresh register
 */
const register = catchAsync(async (req, res) => {
    const { firstName, lastName, email, phone, password, userIntent } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !password) {
        return errorResponse(res, 400, 'First name, last name, email and password are required');
    }

    if (password.length < 8) {
        return errorResponse(res, 400, 'Password must be at least 8 characters');
    }

    const validIntents = ['member', 'admin'];
    if (userIntent && !validIntents.includes(userIntent)) {
        return errorResponse(res, 400, 'userIntent must be "member" or "admin"');
    }

    // Check for existing account
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
        return errorResponse(res, 409, 'An account with this email already exists');
    }

    // Create user — passwordHash field triggers the pre-save bcrypt hook
    const user = await User.create({
        firstName,
        lastName,
        email,
        phone,
        systemRole: userIntent === 'admin' ? 'admin' : 'user',
        passwordHash: password, // plain text here; hook hashes it before save
    });

    const token = signToken(user._id);

    res.status(201).json({
        success: true,
        token,
        user: user.toSafeObject(),
        // Routing hint for the Flutter app — based on what user selected on S-02b.
        // Defaults to 'join_church' if userIntent was not sent.
        nextScreen: userIntent === 'admin' ? 'register_church' : 'join_church',
        hasChurch: false,
    });
});

/**
 * POST /api/auth/login
 *
 * Authenticates a user with email + password.
 * Returns a JWT, the safe user object, and routing hints
 * so the Flutter app knows where to send the user without
 * needing a second API call.
 *
 * Body: { email, password }
 *
 * Response includes:
 *   nextScreen: 'member_home'      → has active membership, member role
 *               'admin_home'       → has active membership, admin/pastor role
 *               'join_church'      → no membership at all
 *               'pending_approval' → membership exists but still pending
 *   hasChurch: boolean
 */
const login = catchAsync(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return errorResponse(res, 400, 'Email and password are required');
    }

    // Explicitly select passwordHash — it's excluded by default (select: false)
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select(
        '+passwordHash'
    );

    if (!user || !user.isActive) {
        return errorResponse(res, 401, 'Invalid email or password');
    }

    const isValid = await user.comparePassword(password);
    if (!isValid) {
        return errorResponse(res, 401, 'Invalid email or password');
    }

    // Update last login timestamp
    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    // Find the most recent membership to determine routing
    const membership = await Membership.findOne({ user: user._id })
        .sort({ createdAt: -1 })
        .select('status role church')
        .lean();

    let nextScreen = 'join_church';
    let hasChurch = false;

    if (membership) {
        hasChurch = true;
        if (membership.status === 'pending') {
            nextScreen = 'pending_approval';
        } else if (membership.status === 'active') {
            const adminRoles = ['admin', 'pastor', 'super_admin'];
            nextScreen = adminRoles.includes(membership.role) ? 'admin_home' : 'member_home';
        }
    }

    const token = signToken(user._id);

    res.status(200).json({
        success: true,
        token,
        user: user.toSafeObject(),
        nextScreen,
        hasChurch,
        // Send the active membership id so Flutter can store it
        // and skip an extra GET /me call on startup
        activeMembershipId: membership?.status === 'active' ? membership._id : null,
        activeChurchId: membership?.status === 'active' ? membership.church : null,
    });
});

/**
 * POST /api/auth/logout
 *
 * Removes the caller's push token from the user document
 * so they stop receiving push notifications on this device.
 *
 * Body: { pushToken }  (optional)
 */
const logout = catchAsync(async (req, res) => {
    const { pushToken } = req.body;

    if (pushToken && req.user) {
        await User.findByIdAndUpdate(req.user._id, {
            $pull: { pushTokens: pushToken },
        });
    }

    res.status(200).json({ success: true, message: 'Logged out successfully' });
});

/**
 * POST /api/auth/forgot-password
 *
 * Generates a password reset token and stores it (hashed)
 * on the user document. In production you'd email the raw
 * token to the user; here we return it for testing purposes.
 *
 * Body: { email }
 */
const forgotPassword = catchAsync(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return errorResponse(res, 400, 'Email is required');
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always return 200 — never reveal whether an email exists
    if (!user) {
        return res.status(200).json({
            success: true,
            message: 'If an account exists, a reset link has been sent',
        });
    }

    // Generate a random 32-byte token, store its SHA-256 hash
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await user.save({ validateBeforeSave: false });

    // TODO: send rawToken via email/SMS in production
    // For development, return it directly
    res.status(200).json({
        success: true,
        message: 'Password reset token generated',
        ...(process.env.NODE_ENV === 'development' && { resetToken: rawToken }),
    });
});

/**
 * POST /api/auth/reset-password/:token
 *
 * Verifies the raw reset token against the stored hash
 * and updates the password.
 *
 * Body: { password }
 */
const resetPassword = catchAsync(async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
        return errorResponse(res, 400, 'Password must be at least 8 characters');
    }

    // Hash the incoming raw token to compare with stored hash
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpiresAt: { $gt: new Date() }, // token must not be expired
    });

    if (!user) {
        return errorResponse(res, 400, 'Reset token is invalid or has expired');
    }

    // Set new password — pre-save hook will hash it
    user.passwordHash = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpiresAt = undefined;
    await user.save();

    sendAuthResponse(res, 200, user);
});

/**
 * POST /api/auth/change-password
 *
 * Allows an authenticated user to change their password
 * by providing their current password for verification.
 *
 * Body: { currentPassword, newPassword }
 * Auth: required
 */
const changePassword = catchAsync(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return errorResponse(res, 400, 'Current password and new password are required');
    }

    if (newPassword.length < 8) {
        return errorResponse(res, 400, 'New password must be at least 8 characters');
    }

    // Fetch with passwordHash — it's select: false by default
    const user = await User.findById(req.user._id).select('+passwordHash');

    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) {
        return errorResponse(res, 401, 'Current password is incorrect');
    }

    user.passwordHash = newPassword; // hook hashes it
    await user.save();

    sendAuthResponse(res, 200, user);
});

// ─────────────────────────────────────────────────────────
// Profile controllers
// ─────────────────────────────────────────────────────────

/**
 * GET /api/users/me
 *
 * Returns the currently authenticated user's profile,
 * including all their church memberships.
 *
 * Auth: required
 */
const getMe = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id);

    if (!user) {
        return errorResponse(res, 404, 'User not found');
    }

    // Fetch memberships across all churches this user belongs to
    const memberships = await Membership.find({ user: user._id })
        .populate('church', 'name code logoUrl')
        .populate('cellGroup', 'name')
        .select('-notes') // exclude private pastoral notes from self-view
        .lean();

    res.status(200).json({
        success: true,
        user: user.toSafeObject(),
        memberships,
    });
});

/**
 * PATCH /api/users/me
 *
 * Updates the authenticated user's own profile fields.
 * Sensitive fields (password, email, systemRole) are blocked here —
 * they have their own dedicated endpoints.
 *
 * Body: any subset of { firstName, lastName, phone, photoUrl,
 *                       dateOfBirth, gender, address }
 * Auth: required
 */
const updateMe = catchAsync(async (req, res) => {
    // Block fields that must not be updated via this endpoint
    const blocked = ['passwordHash', 'email', 'systemRole', 'isActive'];
    const hasBlocked = blocked.some((field) => field in req.body);

    if (hasBlocked) {
        return errorResponse(
            res,
            400,
            'Use the dedicated endpoints to change email or password'
        );
    }

    const allowed = ['firstName', 'lastName', 'phone', 'photoUrl', 'dateOfBirth', 'gender', 'address'];
    const updates = {};

    allowed.forEach((field) => {
        if (req.body[field] !== undefined) {
            updates[field] = req.body[field];
        }
    });

    if (Object.keys(updates).length === 0) {
        return errorResponse(res, 400, 'No valid fields provided for update');
    }

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        {
            new: true,           // return the updated document
            runValidators: true, // run schema validators on the updated fields
        }
    );

    res.status(200).json({
        success: true,
        user: user.toSafeObject(),
    });
});

/**
 * DELETE /api/users/me
 *
 * Soft-deletes the user account by setting isActive = false.
 * Does not remove the document from MongoDB — preserves
 * historical giving records, attendance, and audit trails.
 *
 * Auth: required
 */
const deleteMe = catchAsync(async (req, res) => {
    await User.findByIdAndUpdate(req.user._id, { isActive: false });

    // Also deactivate all memberships
    await Membership.updateMany(
        { user: req.user._id },
        { status: 'inactive' }
    );

    res.status(200).json({
        success: true,
        message: 'Account deactivated successfully',
    });
});

/**
 * PATCH /api/users/me/push-token
 *
 * Registers or removes a device push token.
 * Called by the mobile app after FCM/APNs token is obtained,
 * and on logout to remove the token.
 *
 * Body: { token, action: 'add' | 'remove' }
 * Auth: required
 */
const updatePushToken = catchAsync(async (req, res) => {
    const { token, action } = req.body;

    if (!token || !action) {
        return errorResponse(res, 400, 'token and action are required');
    }

    if (!['add', 'remove'].includes(action)) {
        return errorResponse(res, 400, 'action must be "add" or "remove"');
    }

    const update =
        action === 'add'
            ? { $addToSet: { pushTokens: token } } // addToSet prevents duplicates
            : { $pull: { pushTokens: token } };

    await User.findByIdAndUpdate(req.user._id, update);

    res.status(200).json({ success: true, message: `Push token ${action}ed` });
});

// ─────────────────────────────────────────────────────────
// Admin controllers
// ─────────────────────────────────────────────────────────

/**
 * GET /api/users
 *
 * Lists all users. Super admin only.
 * Supports pagination and search by name or email.
 *
 * Query: ?page=1&limit=20&search=nnamdi&isActive=true
 * Auth: super_admin
 */
const getAllUsers = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};

    if (req.query.search) {
        const regex = new RegExp(req.query.search, 'i');
        filter.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }];
    }

    if (req.query.isActive !== undefined) {
        filter.isActive = req.query.isActive === 'true';
    }

    const [users, total] = await Promise.all([
        User.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }).lean(),
        User.countDocuments(filter),
    ]);

    res.status(200).json({
        success: true,
        total,
        page,
        pages: Math.ceil(total / limit),
        users,
    });
});

/**
 * GET /api/users/:id
 *
 * Returns a single user by ID with all their memberships.
 * Super admin only.
 *
 * Auth: super_admin
 */
const getUserById = catchAsync(async (req, res) => {
    const user = await User.findById(req.params.id);

    if (!user) {
        return errorResponse(res, 404, 'User not found');
    }

    const memberships = await Membership.find({ user: user._id })
        .populate('church', 'name code logoUrl')
        .populate('cellGroup', 'name')
        .lean();

    res.status(200).json({
        success: true,
        user: user.toSafeObject(),
        memberships,
    });
});

/**
 * PATCH /api/users/:id/status
 *
 * Activates or deactivates a user account.
 * Super admin only.
 *
 * Body: { isActive: boolean }
 * Auth: super_admin
 */
const setUserStatus = catchAsync(async (req, res) => {
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
        return errorResponse(res, 400, 'isActive must be a boolean');
    }

    const user = await User.findByIdAndUpdate(
        req.params.id,
        { isActive },
        { new: true }
    );

    if (!user) {
        return errorResponse(res, 404, 'User not found');
    }

    res.status(200).json({
        success: true,
        message: `User ${isActive ? 'activated' : 'deactivated'}`,
        user: user.toSafeObject(),
    });
});

/**
 * GET /api/users/me/notifications
 *
 * Returns paginated in-app notifications for the current user.
 * Marks fetched notifications as read.
 *
 * Query: ?page=1&limit=20&unreadOnly=true
 * Auth: required
 */
const getMyNotifications = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = { user: req.user._id };

    if (req.query.unreadOnly === 'true') {
        filter.isRead = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Notification.countDocuments(filter),
        Notification.countDocuments({ user: req.user._id, isRead: false }),
    ]);

    // Mark fetched notifications as read
    const ids = notifications.filter((n) => !n.isRead).map((n) => n._id);
    if (ids.length > 0) {
        await Notification.updateMany(
            { _id: { $in: ids } },
            { isRead: true, readAt: new Date() }
        );
    }

    res.status(200).json({
        success: true,
        total,
        unreadCount,
        page,
        pages: Math.ceil(total / limit),
        notifications,
    });
});

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

module.exports = {
    // Auth
    register,
    login,
    logout,
    forgotPassword,
    resetPassword,
    changePassword,

    // Profile (self)
    getMe,
    updateMe,
    deleteMe,
    updatePushToken,

    // Notifications
    getMyNotifications,

    // Admin
    getAllUsers,
    getUserById,
    setUserStatus,
};