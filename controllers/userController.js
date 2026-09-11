const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const Membership = require("../models/Membership");
const Notification = require("../models/Notification");
const { send, passwordResetOptions, sendEmail } = require("../utils/email");

// makes a token, 30 days unless env says otherwise
const signToken = (userId) =>
    jwt.sign({ id: userId }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "30d",
    });

// used a couple places where we return token + user together
const sendAuthResponse = (res, statusCode, user) => {
    const token = signToken(user._id);
    res.status(statusCode).json({
        success: true,
        token,
        user: user.toSafeObject(),
    });
};

// FIX: previous version wrapped the promise in braces without returning it,
// so `catchAsync(fn)` resolved to `undefined` synchronously instead of the
// real promise. That's harmless for Express itself (it never awaits route
// handlers), but it silently breaks anything that DOES rely on this
// resolving properly - including tests that await a controller call
// directly, and any future code that chains off the handler's promise.
const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// REVERTED: this project's Flutter app checks response.data['success'],
// not an 'error' field. A previous pass over this file (and every other
// controller touched in this project) mistakenly applied a different
// project's {error, data} convention instead of confirming what this
// app's AuthController etc. actually parse. Back to {success, message}
// to match the real, working frontend contract.
const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

// user picks member or admin on the "who are you" screen, we just echo it back
// so the app knows where to route next, we dont actually store this anywhere
const register = catchAsync(async (req, res) => {
    const { firstName, lastName, email, phone, password, userIntent } = req.body;

    if (!firstName || !lastName || !email || !password) {
        return errorResponse(res, 400, "First name, last name, email and password are required");
    }
    if (password.length < 8) {
        return errorResponse(res, 400, "Password must be at least 8 characters");
    }

    const validIntents = ["member", "admin"];
    if (userIntent && !validIntents.includes(userIntent)) {
        return errorResponse(res, 400, 'userIntent must be "member" or "admin"');
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
        return errorResponse(res, 409, "An account with this email already exists");
    }

    // passwordHash triggers the presave hook that actually hashes it
    const user = await User.create({
        firstName,
        lastName,
        email,
        phone,
        systemRole: userIntent === "admin" ? "admin" : "user",
        passwordHash: password,
    });

    const token = signToken(user._id);

    res.status(201).json({
        success: true,
        token,
        user: user.toSafeObject(),
        // tells flutter where to go next, defaults to join_church if intent missing
        nextScreen: userIntent === "admin" ? "register_church" : "join_church",
        hasChurch: false,
    });
});

// returns nextScreen + hasChurch so the app doesnt need a second call to figure
// out where to route the user after login
const login = catchAsync(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return errorResponse(res, 400, "Email and password are required");
    }

    // gotta explicitly select this, its select:false on the schema
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");

    if (!user || !user.isActive) {
        return errorResponse(res, 401, "Invalid email or password");
    }

    const isValid = await user.comparePassword(password);
    if (!isValid) {
        return errorResponse(res, 401, "Invalid email or password");
    }

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    const membership = await Membership.findOne({ user: user._id })
        .sort({ createdAt: -1 })
        .select("status role church")
        .lean();

    let nextScreen = "join_church";
    let hasChurch = false;

    if (membership) {
        hasChurch = true;
        if (membership.status === "pending") {
            nextScreen = "pending_approval";
        } else if (membership.status === "active") {
            const adminRoles = ["admin", "pastor", "super_admin"];
            nextScreen = adminRoles.includes(membership.role) ? "admin_home" : "member_home";
        }
    }

    const token = signToken(user._id);

    res.status(200).json({
        success: true,
        token,
        user: user.toSafeObject(),
        nextScreen,
        hasChurch,
        // sending these so flutter can skip an extra /me call on startup
        activeMembershipId: membership?.status === "active" ? membership._id : null,
        activeChurchId: membership?.status === "active" ? membership.church : null,
    });
});

// just pulls the push token off this device so it stops getting notifs
const logout = catchAsync(async (req, res) => {
    const { pushToken } = req.body;
    if (pushToken && req.user) {
        await User.findByIdAndUpdate(req.user._id, {
            $pull: { pushTokens: pushToken },
        });
    }
    res.status(200).json({ success: true, message: "Logged out successfully" });
});

// requires current pw to confirm its actually you before changing it
const changePassword = catchAsync(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return errorResponse(res, 400, "Current password and new password are required");
    }
    if (newPassword.length < 8) {
        return errorResponse(res, 400, "New password must be at least 8 characters");
    }

    const user = await User.findById(req.user._id).select("+passwordHash");
    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) {
        return errorResponse(res, 401, "Current password is incorrect");
    }

    user.passwordHash = newPassword; // hook hashes it on save
    await user.save();

    sendAuthResponse(res, 200, user);
});

// profile page basically, includes memberships across every church they're in
const getMe = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id);
    if (!user) {
        return errorResponse(res, 404, "User not found");
    }

    const memberships = await Membership.find({ user: user._id })
        .populate("church", "name code logoUrl")
        .populate("cellGroup", "name")
        .select("-notes") // dont leak pastoral notes back to the member themself
        .lean();

    res.status(200).json({
        success: true,
        user: user.toSafeObject(),
        memberships,
    });
});

// self-edit only, sensitive stuff like email/password go thru their own endpoints
const updateMe = catchAsync(async (req, res) => {
    const blocked = ["passwordHash", "email", "systemRole", "isActive"];
    const hasBlocked = blocked.some((field) => field in req.body);
    if (hasBlocked) {
        return errorResponse(res, 400, "Use the dedicated endpoints to change email or password");
    }

    const allowed = ["firstName", "lastName", "phone", "photoUrl", "dateOfBirth", "gender", "address"];
    const updates = {};
    allowed.forEach((field) => {
        if (req.body[field] !== undefined) {
            updates[field] = req.body[field];
        }
    });

    if (Object.keys(updates).length === 0) {
        return errorResponse(res, 400, "No valid fields provided for update");
    }

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        { new: true, runValidators: true }
    );

    res.status(200).json({ success: true, user: user.toSafeObject() });
});

// soft delete only, keeps giving/attendance history intact for records
const deleteMe = catchAsync(async (req, res) => {
    await User.findByIdAndUpdate(req.user._id, { isActive: false });

    await Membership.updateMany({ user: req.user._id }, { status: "inactive" });

    res.status(200).json({ success: true, message: "Account deactivated successfully" });
});

// app calls this after getting an fcm/apns token, or on logout to clean it up
const updatePushToken = catchAsync(async (req, res) => {
    const { token, action } = req.body;
    if (!token || !action) {
        return errorResponse(res, 400, "token and action are required");
    }
    if (!["add", "remove"].includes(action)) {
        return errorResponse(res, 400, 'action must be "add" or "remove"');
    }

    const update =
        action === "add"
            ? { $addToSet: { pushTokens: token } } // addToSet so we dont get dupes
            : { $pull: { pushTokens: token } };

    await User.findByIdAndUpdate(req.user._id, update);

    res.status(200).json({ success: true, message: `Push token ${action}ed` });
});

// super admin only, lists everyone, basic search + filter
const getAllUsers = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.search) {
        const regex = new RegExp(req.query.search, "i");
        filter.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }];
    }
    if (req.query.isActive !== undefined) {
        filter.isActive = req.query.isActive === "true";
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

const getUserById = catchAsync(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) {
        return errorResponse(res, 404, "User not found");
    }

    const memberships = await Membership.find({ user: user._id })
        .populate("church", "name code logoUrl")
        .populate("cellGroup", "name")
        .lean();

    res.status(200).json({
        success: true,
        user: user.toSafeObject(),
        memberships,
    });
});

// super admin flipping someone on/off
const setUserStatus = catchAsync(async (req, res) => {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
        return errorResponse(res, 400, "isActive must be a boolean");
    }

    const user = await User.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
    if (!user) {
        return errorResponse(res, 404, "User not found");
    }

    res.status(200).json({
        success: true,
        message: `User ${isActive ? "activated" : "deactivated"}`,
        user: user.toSafeObject(),
    });
});

// grabs a page of notifs and marks whatever we just fetched as read
const getMyNotifications = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = { user: req.user._id };
    if (req.query.unreadOnly === "true") {
        filter.isRead = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
        Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Notification.countDocuments(filter),
        Notification.countDocuments({ user: req.user._id, isRead: false }),
    ]);

    const ids = notifications.filter((n) => !n.isRead).map((n) => n._id);
    if (ids.length > 0) {
        await Notification.updateMany({ _id: { $in: ids } }, { isRead: true, readAt: new Date() });
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

// always return success here even if email doesnt exist, otherwise ppl can
// use this to figure out who has an account (email enumeration)
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: "Email address is required" });
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user) {
            return res.json({
                success: true,
                message: "If that email is registered you will receive a reset code",
            });
        }

        // 4 digit code, 1000-9999
        const code = Math.floor(1000 + Math.random() * 9000).toString();

        user.passwordResetCode = code;
        user.passwordResetExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min window
        await user.save();

        send(passwordResetOptions(user.email, user.firstName, code));

        console.log(`reset code for ${user.email}: ${code}`); // TODO remove before shipping

        res.json({ success: true, message: "A 4-digit reset code has been sent to your email" });
    } catch (err) {
        console.log("forgotPassword error:", err);
        res.status(500).json({ success: false, message: "Failed to send reset code. Please try again." });
    }
};

// checks the 4 digit code + swaps in the new password
//
// FIX: this previously called bcrypt.hash(...) directly without ever
// requiring bcrypt anywhere in the file, which threw
// "ReferenceError: bcrypt is not defined" on every call. Two options were
// available: (1) require bcrypt directly (now done at the top of this file),
// or (2) match the rest of the file's pattern and set `passwordHash` to the
// plain value, letting the model's pre-save hook hash it. Went with the
// explicit bcrypt.hash() approach here since `user.password` (not
// `passwordHash`) was the field being set, which doesn't match this file's
// pre-save hook field name at all - if your User schema's hook watches
// `passwordHash`, setting `user.password` wouldn't trigger it anyway. This
// fix assumes there's a genuine standalone `password` field on the schema
// that's expected to hold a bcrypt hash directly. If that's not the case,
// and `passwordHash` is the real field, change the two lines below to:
//   user.passwordHash = newPassword;
// and remove the bcrypt.hash() call entirely.
const resetPassword = async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;
        if (!email || !code || !newPassword) {
            return res.status(400).json({ success: false, message: "Email, code and new password are required" });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
        }

        const user = await User.findOne({
            email: email.toLowerCase().trim(),
            passwordResetCode: code.trim(),
            passwordResetExpiresAt: { $gt: new Date() },
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                message: "Invalid or expired reset code. Please request a new one.",
            });
        }

        user.password = await bcrypt.hash(newPassword, 12);
        user.passwordResetCode = undefined;
        user.passwordResetExpiresAt = undefined;
        user.mustChangePassword = false; // covers the admin-created-account case
        await user.save();

        res.json({ success: true, message: "Password reset successfully. You can now log in." });
    } catch (err) {
        console.log("resetPassword error:", err);
        res.status(500).json({ success: false, message: "Failed to reset password. Please try again." });
    }
};

// just checks the code is good without actually resetting anything yet,
// used so the app can show "code correct" before asking for the new pw
const verifyResetCode = async (req, res) => {
    try {
        const { email, code } = req.body;
        const user = await User.findOne({
            email: email.toLowerCase().trim(),
            passwordResetCode: code.trim(),
            passwordResetExpiresAt: { $gt: new Date() },
        });

        if (!user) {
            return res.status(400).json({ success: false, message: "Invalid or expired code" });
        }

        res.json({ success: true, message: "Code verified" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Verification failed" });
    }
};

// overwrites the same cloudinary file each time so we dont pile up old photos
const uploadPhoto = async (req, res) => {
    if (!req.file) {
        return errorResponse(res, 400, "No image file provided");
    }

    const cloudinary = require("../config/cloudinary");
    const base64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
        folder: `churza/profiles`,
        transformation: [
            { width: 400, height: 400, crop: "fill", gravity: "face" },
            { quality: "auto", fetch_format: "auto" },
        ],
        public_id: `user_${req.user._id}`,
        overwrite: true,
    });

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { photoUrl: result.secure_url },
        { new: true }
    );

    res.json({ success: true, photoUrl: result.secure_url, user: user.toSafeObject() });
};

// sends whatever the user typed straight to support inbox
const submitFeedback = async (req, res) => {
    const { reason, message, email } = req.body;
    if (!reason || !message) {
        return errorResponse(res, 400, "Reason and message are required");
    }
    if (message.trim().length < 10) {
        return errorResponse(res, 400, "Message must be at least 10 characters");
    }

    const senderEmail = email || req.user?.email || "Unknown";
    const senderName = req.user ? `${req.user.firstName} ${req.user.lastName}` : "Anonymous";

    const reasonLabels = {
        bug: "Bug report",
        suggestion: "Feature suggestion",
        giving: "Giving / payment issue",
        account: "Account problem",
        church: "Church management",
        other: "General enquiry",
    };
    const reasonLabel = reasonLabels[reason] || reason;

    await sendEmail({
        to: "support@churza.org",
        replyTo: senderEmail,
        subject: `[Churza Feedback] ${reasonLabel} — from ${senderName}`,
        html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #0B1F3A;">New feedback from Churza app</h2>
        <table style="width:100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold; width: 140px;">From</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${senderName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold;">Email</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${senderEmail}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold;">Reason</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${reasonLabel}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold;">App version</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${req.headers["x-app-version"] || "Unknown"}</td>
          </tr>
        </table>
        <h3 style="color: #0B1F3A;">Message</h3>
        <div style="background: #f9f9f9; border-left: 4px solid #C9A84C;
          padding: 16px; border-radius: 4px; white-space: pre-wrap;">
          ${message.trim()}
        </div>
        <p style="color: #888; font-size: 12px; margin-top: 24px;">
          Sent from Churza mobile app · ${new Date().toUTCString()}
        </p>
      </div>
    `,
    });

    res.json({
        success: true,
        message: "Thank you for your feedback. We will get back to you within 5 business days.",
    });
};

const getNotificationPreferences = catchAsync(async (req, res) => {
    const user = await User.findById(req.user._id).select("notificationPreferences");
    res.json({ success: true, preferences: user.notificationPreferences ?? {} });
});

const updateNotificationPreferences = catchAsync(async (req, res) => {
    const allowed = [
        "announcements", "sermons", "events", "liveStream",
        "checkIn", "prayer", "cellGroup", "giving", "membership",
    ];

    const updates = {};
    allowed.forEach((key) => {
        if (typeof req.body[key] === "boolean") {
            updates[`notificationPreferences.${key}`] = req.body[key];
        }
    });

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, message: "No valid preferences provided" });
    }

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        { new: true }
    ).select("notificationPreferences");

    res.json({ success: true, preferences: user.notificationPreferences });
});

module.exports = {
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
};