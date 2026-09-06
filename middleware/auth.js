const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Membership = require("../models/Membership");

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).send({ error: true, message });

// checks bearer token, attaches user to req.user
const protect = catchAsync(async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return errorResponse(res, 401, "Authentication required. Please log in");
    }

    const token = authHeader.split(" ")[1];

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return errorResponse(res, 401, "Your session has expired. Please log in again");
        }
        return errorResponse(res, 401, "Invalid token. Please log in again");
    }

    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
        return errorResponse(res, 401, "The user account no longer exists or has been deactivated");
    }

    req.user = user;
    next();
});

// gate by systemRole, use after protect middleware
const restrictTo = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.systemRole)) {
        return errorResponse(res, 403, "You do not have permission to perform this action");
    }
    next();
};

// checks user has one of the roles in a specific church
// churchId comes from params first, then body, then query
const requireChurchRole = (...roles) =>
    catchAsync(async (req, res, next) => {
        const churchId = req.params.churchId || req.body.churchId || req.query.churchId;

        if (!churchId) {
            return errorResponse(res, 400, "Church ID is required");
        }

        const membership = await Membership.findOne({
            user: req.user._id,
            church: churchId,
            status: "active",
        });

        if (!membership) {
            return errorResponse(res, 403, "You are not an active member of this church");
        }

        if (!roles.includes(membership.role)) {
            return errorResponse(
                res,
                403,
                `This action requires one of the following roles: ${roles.join(", ")}`
            );
        }

        req.membership = membership;
        req.churchId = churchId;
        next();
    });

// same idea but doesnt care what role, just needs to be an active memeber
// used on member facing stuff - sermons, prayer wall, events etc
const requireActiveMembership = catchAsync(async (req, res, next) => {
    const churchId = req.params.churchId || req.body.churchId || req.query.churchId;

    if (!churchId) {
        return errorResponse(res, 400, "Church ID is required");
    }

    const membership = await Membership.findOne({
        user: req.user._id,
        church: churchId,
        status: "active",
    });

    if (!membership) {
        return errorResponse(res, 403, "You are not an active member of this church");
    }

    req.membership = membership;
    req.churchId = churchId;
    next();
});

// like protect but wont block the request if token missing/bad
// just skips setting req.user, for routes that work w or w/o login
const optionalAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = await User.findById(decoded.id).select("-passwordHash");
        }
    } catch (_) { }
    next();
};

module.exports = {
    protect,
    restrictTo,
    requireChurchRole,
    requireActiveMembership,
    optionalAuth,
};