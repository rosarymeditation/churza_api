/**
 * Global Express error handler.
 * Mounted last in app.js: app.use(errorHandler)
 *
 * Catches all errors forwarded via next(err) — including those
 * thrown inside catchAsync wrappers — and returns a consistent
 * JSON error shape so the mobile app always gets the same format.
 */
const errorHandler = (err, req, res, next) => {
    let statusCode = err.statusCode || 500;
    let message = err.message || 'Something went wrong';

    // ── Mongoose: document not found ──────────────────────
    if (err.name === 'CastError') {
        statusCode = 400;
        message = `Invalid ${err.path}: ${err.value}`;
    }

    // ── Mongoose: duplicate key (e.g. email already exists) ─
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        const value = err.keyValue[field];
        statusCode = 409;
        message = `${field} "${value}" is already in use`;
    }

    // ── Mongoose: validation errors ───────────────────────
    if (err.name === 'ValidationError') {
        statusCode = 400;
        const errors = Object.values(err.errors).map((e) => e.message);
        message = errors.join('. ');
    }

    // ── JWT errors ────────────────────────────────────────
    if (err.name === 'JsonWebTokenError') {
        statusCode = 401;
        message = 'Invalid token. Please log in again';
    }

    if (err.name === 'TokenExpiredError') {
        statusCode = 401;
        message = 'Your session has expired. Please log in again';
    }

    // ── Log in development ────────────────────────────────
    if (process.env.NODE_ENV === 'development') {
        console.error('ERROR:', err);
    }

    res.status(statusCode).json({
        success: false,
        message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
};

module.exports = errorHandler;