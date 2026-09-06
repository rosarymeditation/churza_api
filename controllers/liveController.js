const LiveSession = require("../models/LiveSession");
const Sermon = require("../models/Sermon");
const { notifyLiveStarted } = require("../utils/churchNotifications");

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).send({ error: true, message });

// handles regular watch links, youtu.be short links, /live/ and /shorts/ paths
const extractVideoId = (url) => {
    try {
        const uri = new URL(url);
        if (uri.searchParams.get("v")) return uri.searchParams.get("v");
        if (uri.hostname === "youtu.be") return uri.pathname.slice(1);
        const liveMatch = uri.pathname.match(/\/live\/([^/?]+)/);
        if (liveMatch) return liveMatch[1];
        const shortsMatch = uri.pathname.match(/\/shorts\/([^/?]+)/);
        if (shortsMatch) return shortsMatch[1];
        return null;
    } catch {
        return null;
    }
};

module.exports = {
    getCurrentLive: catchAsync(async (req, res) => {
        const session = await LiveSession.findOne({
            church: req.params.churchId,
            status: "live",
        })
            .populate("startedBy", "firstName lastName")
            .populate("church", "name code logoUrl")
            .lean();

        return res.send({ error: false, data: session || null });
    }),

    startLive: catchAsync(async (req, res) => {
        const { title, youtubeUrl, description } = req.body;

        if (!title) return errorResponse(res, 400, "Title is required");
        if (!youtubeUrl) return errorResponse(res, 400, "YouTube URL is required");

        const videoId = extractVideoId(youtubeUrl);
        if (!videoId) return errorResponse(res, 400, "Invalid YouTube URL");

        // only one live session per church at a time
        const existing = await LiveSession.findOne({
            church: req.params.churchId,
            status: "live",
        });
        if (existing) {
            return errorResponse(
                res,
                409,
                "A live session is already active. End it before starting a new one."
            );
        }

        const session = await LiveSession.create({
            church: req.params.churchId,
            startedBy: req.user._id,
            title: title.trim(),
            description: description?.trim(),
            youtubeUrl: youtubeUrl.trim(),
            youtubeVideoId: videoId,
            status: "live",
            startedAt: new Date(),
            viewerCount: 0,
        });

        await session.populate("startedBy", "firstName lastName");
        await session.populate("church", "name code");

        // tell everyone service is live
        notifyLiveStarted({
            churchId: req.params.churchId,
            churchName: session.church?.name ?? "Your church",
            title: session.title,
        });

        return res.status(201).send({ error: false, data: session });
    }),

    endLive: catchAsync(async (req, res) => {
        const session = await LiveSession.findOne({
            _id: req.params.sessionId,
            church: req.params.churchId,
            status: "live",
        });

        if (!session) return errorResponse(res, 404, "Active live session not found");

        session.status = "ended";
        session.endedAt = new Date();

        // defaults to true - opt out with saveAsSermon: false if you dont want it archived
        if (req.body.saveAsSermon !== false) {
            const sermon = await Sermon.create({
                church: req.params.churchId,
                uploadedBy: req.user._id,
                title: session.title,
                description: session.description,
                speaker: req.body.sermonSpeaker || undefined,
                seriesName: req.body.sermonSeriesName || undefined,
                mediaType: "link",
                videoUrl: session.youtubeUrl,
                status: "published",
                publishedAt: new Date(),
            });

            session.sermonId = sermon._id;
            session.savedAsSermon = true;
            session.sermonSpeaker = req.body.sermonSpeaker;
            session.sermonSeriesName = req.body.sermonSeriesName;
        }

        await session.save();
        await session.populate("startedBy", "firstName lastName");

        return res.send({ error: false, data: session });
    }),

    // silently no-ops if theres no live session, dont wanna 404 on a poll/join call
    joinLive: catchAsync(async (req, res) => {
        const session = await LiveSession.findOne({
            _id: req.params.sessionId,
            church: req.params.churchId,
            status: "live",
        });

        if (!session) return res.send({ error: false });

        const userId = req.user._id.toString();
        const alreadyJoined = session.viewers.some((id) => id.toString() === userId);

        if (!alreadyJoined) {
            session.viewers.push(req.user._id);
            session.viewerCount = session.viewers.length;
            await session.save();
        }

        return res.send({ error: false, viewerCount: session.viewerCount });
    }),

    getLiveHistory: catchAsync(async (req, res) => {
        const limit = Math.min(20, parseInt(req.query.limit) || 10);

        const sessions = await LiveSession.find({
            church: req.params.churchId,
            status: "ended",
        })
            .populate("startedBy", "firstName lastName")
            .sort({ startedAt: -1 })
            .limit(limit)
            .lean();

        return res.send({ error: false, data: sessions });
    }),
};