const LiveSession = require('../models/LiveSession');
const Sermon = require('../models/Sermon');
const { notifyLiveStarted } = require('../utils/churchNotifications');

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

const extractVideoId = (url) => {
    try {
        const uri = new URL(url);
        if (uri.searchParams.get('v')) return uri.searchParams.get('v');
        if (uri.hostname === 'youtu.be') return uri.pathname.slice(1);
        const liveMatch = uri.pathname.match(/\/live\/([^/?]+)/);
        if (liveMatch) return liveMatch[1];
        const shortsMatch = uri.pathname.match(/\/shorts\/([^/?]+)/);
        if (shortsMatch) return shortsMatch[1];
        return null;
    } catch {
        return null;
    }
};

// GET /api/churches/:churchId/live
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

// POST /api/churches/:churchId/live
const startLive = catchAsync(async (req, res) => {
    const { title, youtubeUrl, description } = req.body;

    if (!title) return errorResponse(res, 400, 'Title is required');
    if (!youtubeUrl) return errorResponse(res, 400, 'YouTube URL is required');

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return errorResponse(res, 400, 'Invalid YouTube URL');

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

    // ── Notify all members that service is LIVE ───────────
    notifyLiveStarted({
        churchId: req.params.churchId,
        churchName: session.church?.name ?? 'Your church',
        title: session.title,
    });

    res.status(201).json({ success: true, session });
});

// PATCH /api/churches/:churchId/live/:sessionId
const endLive = catchAsync(async (req, res) => {
    const session = await LiveSession.findOne({
        _id: req.params.sessionId,
        church: req.params.churchId,
        status: 'live',
    });

    if (!session) return errorResponse(res, 404, 'Active live session not found');

    session.status = 'ended';
    session.endedAt = new Date();

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

// PATCH /api/churches/:churchId/live/:sessionId/join
const joinLive = catchAsync(async (req, res) => {
    const session = await LiveSession.findOne({
        _id: req.params.sessionId,
        church: req.params.churchId,
        status: 'live',
    });

    if (!session) return res.json({ success: true });

    const userId = req.user._id.toString();
    const alreadyJoined = session.viewers.some((id) => id.toString() === userId);

    if (!alreadyJoined) {
        session.viewers.push(req.user._id);
        session.viewerCount = session.viewers.length;
        await session.save();
    }

    res.json({ success: true, viewerCount: session.viewerCount });
});

// GET /api/churches/:churchId/live/history
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