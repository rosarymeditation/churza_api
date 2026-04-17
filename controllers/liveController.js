const LiveSession = require('../models/LiveSession');
const Sermon = require('../models/Sermon');

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

// ── Extract YouTube video ID from any URL ─────────────────
const extractVideoId = (url) => {
    try {
        const uri = new URL(url);
        // youtube.com/watch?v=ID
        if (uri.searchParams.get('v')) return uri.searchParams.get('v');
        // youtu.be/ID
        if (uri.hostname === 'youtu.be') return uri.pathname.slice(1);
        // youtube.com/live/ID
        const liveMatch = uri.pathname.match(/\/live\/([^/?]+)/);
        if (liveMatch) return liveMatch[1];
        // youtube.com/shorts/ID
        const shortsMatch = uri.pathname.match(/\/shorts\/([^/?]+)/);
        if (shortsMatch) return shortsMatch[1];
        return null;
    } catch {
        return null;
    }
};

// ─────────────────────────────────────────────────────────
// GET /api/churches/:churchId/live
// Returns the current live session for a church (if any)
// Auth: protect + requireActiveMembership
// ─────────────────────────────────────────────────────────
const getCurrentLive = catchAsync(async (req, res) => {
    const session = await LiveSession.findOne({
        church: req.params.churchId,
        status: 'live',
    })
        .populate('startedBy', 'firstName lastName')
        .populate('church', 'name code logoUrl')
        .lean();

    res.json({ success: true, session: session || null });
});

// ─────────────────────────────────────────────────────────
// POST /api/churches/:churchId/live
// Admin starts a live session
// Auth: protect + requireChurchRole('admin', 'pastor')
// ─────────────────────────────────────────────────────────
const startLive = catchAsync(async (req, res) => {
    const { title, youtubeUrl, description } = req.body;

    if (!title) return errorResponse(res, 400, 'Title is required');
    if (!youtubeUrl) return errorResponse(res, 400, 'YouTube URL is required');

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
        return errorResponse(res, 400, 'Invalid YouTube URL');
    }

    // Check for existing live session
    const existing = await LiveSession.findOne({
        church: req.params.churchId,
        status: 'live',
    });

    if (existing) {
        return errorResponse(res, 409,
            'A live session is already active. End it before starting a new one.');
    }

    const session = await LiveSession.create({
        church: req.params.churchId,
        startedBy: req.user._id,
        title: title.trim(),
        description: description?.trim(),
        youtubeUrl: youtubeUrl.trim(),
        youtubeVideoId: videoId,
        status: 'live',
        startedAt: new Date(),
        viewerCount: 0,
    });

    await session.populate('startedBy', 'firstName lastName');
    await session.populate('church', 'name code');

    res.status(201).json({ success: true, session });
});

// ─────────────────────────────────────────────────────────
// PATCH /api/churches/:churchId/live/:sessionId
// Admin ends the live session — optionally saves as sermon
// Auth: protect + requireChurchRole('admin', 'pastor')
// ─────────────────────────────────────────────────────────
const endLive = catchAsync(async (req, res) => {
    const session = await LiveSession.findOne({
        _id: req.params.sessionId,
        church: req.params.churchId,
        status: 'live',
    });

    if (!session) {
        return errorResponse(res, 404, 'Active live session not found');
    }

    session.status = 'ended';
    session.endedAt = new Date();

    // ── Auto-save as sermon ────────────────────────────────
    if (req.body.saveAsSermon !== false) {
        const sermon = await Sermon.create({
            church: req.params.churchId,
            uploadedBy: req.user._id,
            title: session.title,
            description: session.description,
            speaker: req.body.sermonSpeaker || undefined,
            seriesName: req.body.sermonSeriesName || undefined,
            mediaType: 'link',
            videoUrl: session.youtubeUrl,
            status: 'published',
            publishedAt: new Date(),
        });

        session.sermonId = sermon._id;
        session.savedAsSermon = true;
        session.sermonSpeaker = req.body.sermonSpeaker;
        session.sermonSeriesName = req.body.sermonSeriesName;
    }

    await session.save();
    await session.populate('startedBy', 'firstName lastName');

    res.json({ success: true, session });
});

// ─────────────────────────────────────────────────────────
// PATCH /api/churches/:churchId/live/:sessionId/join
// Member joins — increments viewer count
// Auth: protect + requireActiveMembership
// ─────────────────────────────────────────────────────────
const joinLive = catchAsync(async (req, res) => {
    const session = await LiveSession.findOne({
        _id: req.params.sessionId,
        church: req.params.churchId,
        status: 'live',
    });

    if (!session) return res.json({ success: true }); // silent fail

    const userId = req.user._id.toString();
    const alreadyJoined = session.viewers.some(
        (id) => id.toString() === userId
    );

    if (!alreadyJoined) {
        session.viewers.push(req.user._id);
        session.viewerCount = session.viewers.length;
        await session.save();
    }

    res.json({ success: true, viewerCount: session.viewerCount });
});

// ─────────────────────────────────────────────────────────
// GET /api/churches/:churchId/live/history
// Past live sessions
// Auth: protect + requireActiveMembership
// ─────────────────────────────────────────────────────────
const getLiveHistory = catchAsync(async (req, res) => {
    const limit = Math.min(20, parseInt(req.query.limit) || 10);

    const sessions = await LiveSession.find({
        church: req.params.churchId,
        status: 'ended',
    })
        .populate('startedBy', 'firstName lastName')
        .sort({ startedAt: -1 })
        .limit(limit)
        .lean();

    res.json({ success: true, sessions });
});

module.exports = {
    getCurrentLive,
    startLive,
    endLive,
    joinLive,
    getLiveHistory,
};