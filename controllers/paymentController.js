require("dotenv").config();
const stripe = require("../config/stripe");
const Church = require("../models/Church");
const mongoose = require("mongoose");
const Membership = require("../models/Membership");
const GivingTransaction = require("../models/GivingTransaction");
const {
    notifyGivingConfirmed,
    notifyLargeGiftReceived,
    notifyStripeVerified,
} = require("../utils/churchNotifications");

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).send({ error: true, message });

const _capitalise = (str) => str.charAt(0).toUpperCase() + str.slice(1);

module.exports = {
    // ── Stripe Connect — admin onboarding ───────────────────
    connectStripe: catchAsync(async (req, res) => {
        const church = await Church.findById(req.params.churchId);
        if (!church) return errorResponse(res, 404, "Church not found");

        // already connected and good to go, nothing to do
        if (church.settings.stripeAccountId) {
            const account = await stripe.accounts.retrieve(church.settings.stripeAccountId);
            if (account.charges_enabled) {
                return res.send({ error: false, connected: true, message: "Stripe already connected" });
            }
        }

        const account = await stripe.accounts.create({
            type: "express",
            country: req.body.country || "GB",
            email: req.body.email || req.user.email,
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
            business_profile: {
                name: church.name,
                url: church.contact?.website || undefined,
            },
        });

        await Church.findByIdAndUpdate(req.params.churchId, {
            "settings.stripeAccountId": account.id,
            "settings.activeGateway": "stripe",
        });

        const accountLink = await stripe.accountLinks.create({
            account: account.id,
            refresh_url: "https://churza.app/onboarding/error",
            return_url: "https://churza.app/onboarding/success",
            type: "account_onboarding",
        });

        return res.status(200).send({
            error: false,
            onboardingUrl: accountLink.url,
            accountId: account.id,
        });
    }),

    connectStatus: catchAsync(async (req, res) => {
        const church = await Church.findById(req.params.churchId);
        if (!church) return errorResponse(res, 404, "Church not found");

        if (!church.settings?.stripeAccountId) {
            return res.send({ error: false, connected: false, message: "No Stripe account linked" });
        }

        const account = await stripe.accounts.retrieve(church.settings.stripeAccountId);
        const ready = account.charges_enabled && account.payouts_enabled;

        // flip givingEnabled on the first time we see it become ready
        if (ready && !church.settings.givingEnabled) {
            await Church.findByIdAndUpdate(req.params.churchId, {
                "settings.givingEnabled": true,
            });
        }

        return res.send({
            error: false,
            connected: ready,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            accountId: account.id,
            requiresAction: (account.requirements?.currently_due?.length || 0) > 0,
            dueSoon: account.requirements?.currently_due || [],
        });
    }),

    disconnectStripe: catchAsync(async (req, res) => {
        const church = await Church.findById(req.params.churchId);
        if (!church) return errorResponse(res, 404, "Church not found");

        if (church.settings?.stripeAccountId) {
            // best effort, dont block disconnect if stripe side fails
            await stripe.oauth
                .deauthorize({
                    client_id: process.env.STRIPE_CLIENT_ID,
                    stripe_user_id: church.settings.stripeAccountId,
                })
                .catch(() => { });
        }

        await Church.findByIdAndUpdate(req.params.churchId, {
            "settings.stripeAccountId": null,
            "settings.activeGateway": "none",
            "settings.givingEnabled": false,
        });

        return res.send({ error: false, message: "Stripe disconnected" });
    }),

    // ── Giving — member payments ─────────────────────────────
    createPaymentIntent: catchAsync(async (req, res) => {
        const { amount, currency, type, note } = req.body;

        if (!amount || !Number.isInteger(amount) || amount < 100) {
            return errorResponse(res, 400, "Minimum giving amount is £1.00");
        }

        const validTypes = ["tithe", "offering", "seed", "donation", "building", "missions"];
        const givingType = validTypes.includes(type) ? type : "offering";

        const church = await Church.findById(req.params.churchId).select("name settings");
        if (!church) return errorResponse(res, 404, "Church not found");

        if (!church.settings?.givingEnabled) {
            return errorResponse(
                res,
                400,
                "Online giving is not enabled for this church. Please contact your pastor."
            );
        }
        if (!church.settings?.stripeAccountId) {
            return errorResponse(
                res,
                400,
                "This church has not set up online giving yet. Please contact your pastor."
            );
        }

        const PLATFORM_FEE_PERCENT = 0.015;
        const MINIMUM_PLATFORM_FEE = 30;
        const platformFee = Math.max(
            Math.round(amount * PLATFORM_FEE_PERCENT),
            MINIMUM_PLATFORM_FEE
        );

        const givingCurrency = (currency || church.settings?.currency || "gbp").toLowerCase();

        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: givingCurrency,
            application_fee_amount: platformFee,
            transfer_data: { destination: church.settings.stripeAccountId },
            metadata: {
                churchId: church._id.toString(),
                churchName: church.name,
                userId: req.user._id.toString(),
                userEmail: req.user.email,
                userName: `${req.user.firstName} ${req.user.lastName}`,
                givingType,
                note: note?.trim() || "",
                platformFee: platformFee.toString(),
                environment: process.env.NODE_ENV || "development",
            },
            description: `${_capitalise(givingType)} — ${church.name}`,
            receipt_email: req.user.email,
        });

        return res.send({
            error: false,
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            amount,
            currency: paymentIntent.currency,
            platformFee,
            breakDown: { giving: amount, platformFee, total: amount },
        });
    }),

    confirmPayment: catchAsync(async (req, res) => {
        const { paymentIntentId, amount, currency, type, note } = req.body;
        if (!paymentIntentId) return errorResponse(res, 400, "Payment intent ID required");

        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== "succeeded") {
            return errorResponse(res, 400, `Payment not confirmed — status: ${intent.status}`);
        }

        // client might call this twice, dont double record
        const existing = await GivingTransaction.findOne({ reference: paymentIntentId });
        if (existing) {
            return res.send({ error: false, data: existing, duplicate: true });
        }

        const transaction = await GivingTransaction.create({
            church: req.params.churchId,
            user: req.user._id,
            amount: amount / 100,
            currency: (currency || "GBP").toUpperCase(),
            type: type || "offering",
            method: "stripe",
            status: "completed",
            reference: paymentIntentId,
            note: note || undefined,
            processedAt: new Date(),
        });

        return res.status(201).send({ error: false, data: transaction });
    }),

    myGivingHistory: catchAsync(async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

        const transactions = await GivingTransaction.find({
            church: req.params.churchId,
            user: req.user._id,
            status: "completed",
        })
            .sort({ processedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const total = await GivingTransaction.countDocuments({
            church: req.params.churchId,
            user: req.user._id,
            status: "completed",
        });

        const totals = await GivingTransaction.aggregate([
            {
                $match: {
                    church: new mongoose.Types.ObjectId(req.params.churchId),
                    user: new mongoose.Types.ObjectId(req.user._id),
                    status: "completed",
                },
            },
            { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]);

        return res.send({ error: false, total, page, data: transactions, totals });
    }),

    // ── Admin — church giving overview ──────────────────────
    givingOverview: catchAsync(async (req, res) => {
        const now = new Date();
        const monthStr =
            req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const [year, month] = monthStr.split("-").map(Number);
        const startOfMonth = new Date(year, month - 1, 1);
        const endOfMonth = new Date(year, month, 1);

        const [monthly, allTime, recent] = await Promise.all([
            GivingTransaction.aggregate([
                {
                    $match: {
                        church: new mongoose.Types.ObjectId(req.params.churchId),
                        status: "completed",
                        processedAt: { $gte: startOfMonth, $lt: endOfMonth },
                    },
                },
                {
                    $group: {
                        _id: "$type",
                        total: { $sum: "$amount" },
                        count: { $sum: 1 },
                        currency: { $first: "$currency" },
                    },
                },
            ]),
            GivingTransaction.aggregate([
                {
                    $match: {
                        church: new mongoose.Types.ObjectId(req.params.churchId),
                        status: "completed",
                    },
                },
                { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
            ]),
            GivingTransaction.find({ church: req.params.churchId, status: "completed" })
                .populate("user", "firstName lastName photoUrl")
                .sort({ processedAt: -1 })
                .limit(10)
                .lean(),
        ]);

        return res.send({
            error: false,
            month: monthStr,
            monthly,
            allTime: allTime[0] || { total: 0, count: 0 },
            recent,
        });
    }),

    allTransactions: catchAsync(async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

        const filter = { church: req.params.churchId, status: "completed" };
        if (req.query.type) filter.type = req.query.type;
        if (req.query.userId) filter.user = req.query.userId;

        const [transactions, total] = await Promise.all([
            GivingTransaction.find(filter)
                .populate("user", "firstName lastName photoUrl")
                .sort({ processedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            GivingTransaction.countDocuments(filter),
        ]);

        return res.send({ error: false, total, page, data: transactions });
    }),

    recordCash: catchAsync(async (req, res) => {
        const { userId, amount, currency, type, note, date } = req.body;
        if (!amount || amount <= 0) return errorResponse(res, 400, "Valid amount required");

        const transaction = await GivingTransaction.create({
            church: req.params.churchId,
            user: userId || req.user._id,
            amount,
            currency: (currency || "GBP").toUpperCase(),
            type: type || "offering",
            method: "cash",
            status: "completed",
            note: note || undefined,
            recordedBy: req.user._id,
            processedAt: date ? new Date(date) : new Date(),
        });

        await transaction.populate("user", "firstName lastName");
        return res.status(201).send({ error: false, data: transaction });
    }),

    // UK tax year runs Apr 6 - Apr 5, not calendar year
    giftAidReport: catchAsync(async (req, res) => {
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const startDate = new Date(year, 3, 6);
        const endDate = new Date(year + 1, 3, 5, 23, 59, 59);

        const memberGiving = await GivingTransaction.aggregate([
            {
                $match: {
                    church: new mongoose.Types.ObjectId(req.params.churchId),
                    status: "completed",
                    processedAt: { $gte: startDate, $lte: endDate },
                },
            },
            {
                $group: {
                    _id: "$user",
                    total: { $sum: "$amount" },
                    count: { $sum: 1 },
                    currency: { $first: "$currency" },
                    types: { $addToSet: "$type" },
                },
            },
            {
                $lookup: {
                    from: "users",
                    localField: "_id",
                    foreignField: "_id",
                    as: "user",
                },
            },
            { $unwind: "$user" },
            {
                $project: {
                    userId: "$_id",
                    name: { $concat: ["$user.firstName", " ", "$user.lastName"] },
                    email: "$user.email",
                    total: 1,
                    count: 1,
                    currency: 1,
                    types: 1,
                },
            },
            { $sort: { total: -1 } },
        ]);

        const totalGiving = memberGiving.reduce((sum, m) => sum + m.total, 0);
        const totalGiftAid = totalGiving * 0.25; // basic rate reclaim, 25p per £1

        return res.send({
            error: false,
            taxYear: `${year}–${year + 1}`,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            memberCount: memberGiving.length,
            totalGiving,
            totalGiftAid,
            members: memberGiving,
        });
    }),

    // ── Webhook — Stripe events ──────────────────────────────
    // NOTE: needs req.body as the raw untouched buffer for constructEvent
    // to verify the signature - make sure this route is registered with
    // express.raw() BEFORE express.json() runs globally, same issue as
    // the other Stripe/Paystack webhooks in this project.
    handleWebhook: async (req, res) => {
        const sig = req.headers["stripe-signature"];
        let event;

        try {
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.log("Webhook signature failed:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        switch (event.type) {
            case "payment_intent.succeeded": {
                const intent = event.data.object;

                const tx = await GivingTransaction.findOneAndUpdate(
                    { reference: intent.id },
                    { status: "completed", processedAt: new Date() },
                    { new: true }
                ).lean();

                if (tx) {
                    notifyGivingConfirmed({
                        userId: tx.user?.toString(),
                        amount: intent.amount,
                        currency: intent.currency,
                        type: intent.metadata?.givingType,
                        churchName: intent.metadata?.churchName ?? "your church",
                    });

                    // threshold £500 (50000 pence), tweak as needed
                    notifyLargeGiftReceived({
                        churchId: tx.church?.toString(),
                        memberName: intent.metadata?.userName ?? "A member",
                        amount: intent.amount,
                        currency: intent.currency,
                        threshold: 50000,
                    });
                }

                console.log(`Payment succeeded: ${intent.id} — ${intent.amount} ${intent.currency}`);
                break;
            }

            case "payment_intent.payment_failed": {
                const intent = event.data.object;
                console.log(`Payment failed: ${intent.id} — ${intent.last_payment_error?.message}`);
                break;
            }

            // fires when a pastor finishes onboarding and charges_enabled flips true
            case "account.updated": {
                const account = event.data.object;
                const justEnabled =
                    account.charges_enabled && event.data.previous_attributes?.charges_enabled === false;

                if (justEnabled) {
                    try {
                        const church = await Church.findOne({
                            "settings.stripeAccountId": account.id,
                        }).populate("createdBy", "firstName lastName email");

                        if (church) {
                            await Church.findByIdAndUpdate(church._id, {
                                "settings.givingEnabled": true,
                            });

                            if (church.createdBy) {
                                notifyStripeVerified({
                                    userId: church.createdBy._id.toString(),
                                    churchName: church.name,
                                });
                            }

                            console.log(`Stripe verified for ${church.name} — giving enabled`);
                        }
                    } catch (err) {
                        // non critical, log and move on so we still ack the webhook
                        console.log("account.updated handler error:", err.message);
                    }
                }

                console.log(`Account updated: ${account.id} — charges_enabled: ${account.charges_enabled}`);
                break;
            }

            default:
                console.log(`Unhandled Stripe event: ${event.type}`);
        }

        // stripe wants a 200 within 30s regardless of what we did above
        return res.send({ received: true });
    },
};