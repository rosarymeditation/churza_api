const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Membership = require('../models/Membership');

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

// ─────────────────────────────────────────────────────────
// protect
// ─────────────────────────────────────────────────────────

/**
 * Verifies the Bearer JWT from the Authorization header.
 * On success, attaches the full user document to req.user
 * so downstream controllers can access it without another DB query.
 *
 * Usage: router.get('/me', protect, getMe)
 */
const protect = catchAsync(async (req, res, next) => {
    // 1. Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return errorResponse(res, 401, 'Authentication required. Please log in');
    }

    const token = authHeader.split(' ')[1];

    // 2. Verify token signature and expiry
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return errorResponse(res, 401, 'Your session has expired. Please log in again');
        }
        return errorResponse(res, 401, 'Invalid token. Please log in again');
    }

    // 3. Check the user still exists and is active
    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
        return errorResponse(res, 401, 'The user account no longer exists or has been deactivated');
    }

    // 4. Attach to request — available in all downstream middleware and controllers
    req.user = user;
    next();
});

// ─────────────────────────────────────────────────────────
// restrictTo
// ─────────────────────────────────────────────────────────

/**
 * Restricts a route to users whose systemRole is in the
 * provided list. Must be used AFTER protect.
 *
 * Usage: router.get('/users', protect, restrictTo('super_admin'), getAllUsers)
 */
const restrictTo = (...roles) =>
    (req, res, next) => {
        if (!roles.includes(req.user.systemRole)) {
            return errorResponse(res, 403, 'You do not have permission to perform this action');
        }
        next();
    };

// ─────────────────────────────────────────────────────────
// requireChurchRole
// ─────────────────────────────────────────────────────────

/**
 * Checks that the authenticated user has one of the given
 * roles within a specific church.
 *
 * Reads churchId from:
 *   1. req.params.churchId
 *   2. req.body.churchId
 *   3. req.query.churchId
 *
 * On success, attaches req.membership so downstream controllers
 * can read the role, status, cellGroup, etc. without another query.
 *
 * Usage:
 *   router.post('/sessions', protect, requireChurchRole('admin', 'pastor'), openSession)
 *   router.get('/members',   protect, requireChurchRole('admin', 'pastor', 'worker'), getMembers)
 */
const requireChurchRole = (...roles) =>
    catchAsync(async (req, res, next) => {
        const churchId =
            req.params.churchId ||
            req.body.churchId ||
            req.query.churchId;

        if (!churchId) {
            return errorResponse(res, 400, 'Church ID is required');
        }

        const membership = await Membership.findOne({
            user: req.user._id,
            church: churchId,
            status: 'active',
        });

        if (!membership) {
            return errorResponse(res, 403, 'You are not an active member of this church');
        }

        if (!roles.includes(membership.role)) {
            return errorResponse(
                res,
                403,
                `This action requires one of the following roles: ${roles.join(', ')}`
            );
        }

        req.membership = membership;
        req.churchId = churchId;
        next();
    });

// ─────────────────────────────────────────────────────────
// requireActiveMembership
// ─────────────────────────────────────────────────────────

/**
 * Looser version of requireChurchRole — only checks that the
 * user has an active membership in the church, regardless of role.
 * Used for member-facing routes (sermons, prayer wall, events).
 *
 * Attaches req.membership and req.churchId on success.
 */
const requireActiveMembership = catchAsync(async (req, res, next) => {
    const churchId =
        req.params.churchId ||
        req.body.churchId ||
        req.query.churchId;

    if (!churchId) {
        return errorResponse(res, 400, 'Church ID is required');
    }

    const membership = await Membership.findOne({
        user: req.user._id,
        church: churchId,
        status: 'active',
    });

    if (!membership) {
        return errorResponse(res, 403, 'You are not an active member of this church');
    }

    req.membership = membership;
    req.churchId = churchId;
    next();
});

module.exports = {
    protect,
    restrictTo,
    requireChurchRole,
    requireActiveMembership,
};