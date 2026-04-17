/**
 * rentflow/utils/token.js
 * JWT signing and user response formatting
 */
const jwt = require("jsonwebtoken");

const signToken = (user) =>
    jwt.sign(
        { sub: user._id, email: user.email },
        process.env.JWT_SECRET || "dev_secret",
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

// Strips sensitive fields — safe to send to Flutter app
const formatUser = (user) => ({
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone || null,
    avatar: user.avatar || null,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt || null,
    isEmailVerified: user.isEmailVerified,
    stripeOnboardingComplete: user.stripeOnboardingComplete,
    settings: user.settings,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
});

module.exports = { signToken, formatUser };