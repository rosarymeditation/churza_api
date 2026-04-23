require('dotenv').config();
const stripe = require('../config/stripe');
const Church = require('../models/Church');
const mongoose = require('mongoose');
const Membership = require('../models/Membership');
const GivingTransaction = require('../models/GivingTransaction');
const {
    notifyGivingConfirmed,
    notifyLargeGiftReceived,
    notifyStripeVerified,
} = require('../utils/churchNotifications');

const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

// ─────────────────────────────────────────────────────────
// Stripe Connect — Admin onboarding
// ─────────────────────────────────────────────────────────

const connectStripe = catchAsync(async (req, res) => {
    const church = await Church.findById(req.params.churchId);
    if (!church) return errorResponse(res, 404, 'Church not found');

    if (church.settings.stripeAccountId) {
        const account = await stripe.accounts.retrieve(church.settings.stripeAccountId);
        if (account.charges_enabled) {
            return res.json({ success: true, connected: true, message: 'Stripe already connected' });
        }
    }

    const account = await stripe.accounts.create({
        type: 'express',
        country: req.body.country || 'GB',
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
        'settings.stripeAccountId': account.id,
        'settings.activeGateway': 'stripe',
    });

    const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: 'https://churza.app/onboarding/error',
        return_url: 'https://churza.app/onboarding/success',
        type: 'account_onboarding',
    });

    res.status(200).json({
        success: true,
        onboardingUrl: accountLink.url,
        accountId: account.id,
    });
});

const connectStatus = catchAsync(async (req, res) => {
    const church = await Church.findById(req.params.churchId);
    if (!church) return errorResponse(res, 404, 'Church not found');

    if (!church.settings?.stripeAccountId) {
        return res.json({ success: true, connected: false, message: 'No Stripe account linked' });
    }

    const account = await stripe.accounts.retrieve(church.settings.stripeAccountId);
    const ready = account.charges_enabled && account.payouts_enabled;

    if (ready && !church.settings.givingEnabled) {
        await Church.findByIdAndUpdate(req.params.churchId, {
            'settings.givingEnabled': true,
        });
    }

    res.json({
        success: true,
        connected: ready,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        accountId: account.id,
        requiresAction: (account.requirements?.currently_due?.length || 0) > 0,
        dueSoon: account.requirements?.currently_due || [],
    });
});

const disconnectStripe = catchAsync(async (req, res) => {
    const church = await Church.findById(req.params.churchId);
    if (!church) return errorResponse(res, 404, 'Church not found');

    if (church.settings?.stripeAccountId) {
        await stripe.oauth.deauthorize({
            client_id: process.env.STRIPE_CLIENT_ID,
            stripe_user_id: church.settings.stripeAccountId,
        }).catch(() => { });
    }

    await Church.findByIdAndUpdate(req.params.churchId, {
        'settings.stripeAccountId': null,
        'settings.activeGateway': 'none',
        'settings.givingEnabled': false,
    });

    res.json({ success: true, message: 'Stripe disconnected' });
});

// ─────────────────────────────────────────────────────────
// Giving — Member payments
// ─────────────────────────────────────────────────────────

const _capitalise = (str) => str.charAt(0).toUpperCase() + str.slice(1);

const createPaymentIntent = catchAsync(async (req, res) => {
    const { amount, currency, type, note } = req.body;

    if (!amount || !Number.isInteger(amount) || amount < 100) {
        return errorResponse(res, 400, 'Minimum giving amount is £1.00');
    }

    const validTypes = ['tithe', 'offering', 'seed', 'donation', 'building', 'missions'];
    const givingType = validTypes.includes(type) ? type : 'offering';

    const church = await Church.findById(req.params.churchId).select('name settings');
    if (!church) return errorResponse(res, 404, 'Church not found');

    if (!church.settings?.givingEnabled) {
        return errorResponse(res, 400,
            'Online giving is not enabled for this church. Please contact your pastor.');
    }

    if (!church.settings?.stripeAccountId) {
        return errorResponse(res, 400,
            'This church has not set up online giving yet. Please contact your pastor.');
    }

    const PLATFORM_FEE_PERCENT = 0.015;
    const MINIMUM_PLATFORM_FEE = 30;
    const platformFee = Math.max(
        Math.round(amount * PLATFORM_FEE_PERCENT),
        MINIMUM_PLATFORM_FEE
    );

    const givingCurrency = (currency || church.settings?.currency || 'gbp').toLowerCase();

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
            note: note?.trim() || '',
            platformFee: platformFee.toString(),
            environment: process.env.NODE_ENV || 'development',
        },
        description: `${_capitalise(givingType)} — ${church.name}`,
        receipt_email: req.user.email,
    });

    res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
        currency: paymentIntent.currency,
        platformFee,
        breakDown: { giving: amount, platformFee, total: amount },
    });
});

const confirmPayment = catchAsync(async (req, res) => {
    const { paymentIntentId, amount, currency, type, note } = req.body;

    if (!paymentIntentId) return errorResponse(res, 400, 'Payment intent ID required');

    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') {
        return errorResponse(res, 400, `Payment not confirmed — status: ${intent.status}`);
    }

    const existing = await GivingTransaction.findOne({ reference: paymentIntentId });
    if (existing) {
        return res.json({ success: true, transaction: existing, duplicate: true });
    }

    const transaction = await GivingTransaction.create({
        church: req.params.churchId,
        user: req.user._id,
        amount: amount / 100,
        currency: (currency || 'GBP').toUpperCase(),
        type: type || 'offering',
        method: 'stripe',
        status: 'completed',
        reference: paymentIntentId,
        note: note || undefined,
        processedAt: new Date(),
    });

    res.status(201).json({ success: true, transaction });
});

const myGivingHistory = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const transactions = await GivingTransaction.find({
        church: req.params.churchId,
        user: req.user._id,
        status: 'completed',
    })
        .sort({ processedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

    const total = await GivingTransaction.countDocuments({
        church: req.params.churchId,
        user: req.user._id,
        status: 'completed',
    });

    const totals = await GivingTransaction.aggregate([
        {
            $match: {
                church: new mongoose.Types.ObjectId(req.params.churchId),
                user: new mongoose.Types.ObjectId(req.user._id),
                status: 'completed',
            },
        },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    res.json({ success: true, total, page, transactions, totals });
});

// ─────────────────────────────────────────────────────────
// Admin — Church giving overview
// ─────────────────────────────────────────────────────────

const givingOverview = catchAsync(async (req, res) => {
    const now = new Date();
    const monthStr = req.query.month ||
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [year, month] = monthStr.split('-').map(Number);
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 1);

    const [monthly, allTime, recent] = await Promise.all([
        GivingTransaction.aggregate([
            {
                $match: {
                    church: new mongoose.Types.ObjectId(req.params.churchId),
                    status: 'completed',
                    processedAt: { $gte: startOfMonth, $lt: endOfMonth },
                },
            },
            {
                $group: {
                    _id: '$type',
                    total: { $sum: '$amount' },
                    count: { $sum: 1 },
                    currency: { $first: '$currency' },
                },
            },
        ]),
        GivingTransaction.aggregate([
            {
                $match: {
                    church: new mongoose.Types.ObjectId(req.params.churchId),
                    status: 'completed',
                },
            },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        ]),
        GivingTransaction.find({ church: req.params.churchId, status: 'completed' })
            .populate('user', 'firstName lastName photoUrl')
            .sort({ processedAt: -1 })
            .limit(10)
            .lean(),
    ]);

    res.json({
        success: true,
        month: monthStr,
        monthly,
        allTime: allTime[0] || { total: 0, count: 0 },
        recent,
    });
});

const allTransactions = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = { church: req.params.churchId, status: 'completed' };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.userId) filter.user = req.query.userId;

    const [transactions, total] = await Promise.all([
        GivingTransaction.find(filter)
            .populate('user', 'firstName lastName photoUrl')
            .sort({ processedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        GivingTransaction.countDocuments(filter),
    ]);

    res.json({ success: true, total, page, transactions });
});

const recordCash = catchAsync(async (req, res) => {
    const { userId, amount, currency, type, note, date } = req.body;

    if (!amount || amount <= 0) return errorResponse(res, 400, 'Valid amount required');

    const transaction = await GivingTransaction.create({
        church: req.params.churchId,
        user: userId || req.user._id,
        amount,
        currency: (currency || 'GBP').toUpperCase(),
        type: type || 'offering',
        method: 'cash',
        status: 'completed',
        note: note || undefined,
        recordedBy: req.user._id,
        processedAt: date ? new Date(date) : new Date(),
    });

    await transaction.populate('user', 'firstName lastName');
    res.status(201).json({ success: true, transaction });
});

// ─────────────────────────────────────────────────────────
// Gift Aid report
// ─────────────────────────────────────────────────────────

const giftAidReport = catchAsync(async (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const startDate = new Date(year, 3, 6);
    const endDate = new Date(year + 1, 3, 5, 23, 59, 59);

    const memberGiving = await GivingTransaction.aggregate([
        {
            $match: {
                church: new mongoose.Types.ObjectId(req.params.churchId),
                status: 'completed',
                processedAt: { $gte: startDate, $lte: endDate },
            },
        },
        {
            $group: {
                _id: '$user',
                total: { $sum: '$amount' },
                count: { $sum: 1 },
                currency: { $first: '$currency' },
                types: { $addToSet: '$type' },
            },
        },
        {
            $lookup: {
                from: 'users',
                localField: '_id',
                foreignField: '_id',
                as: 'user',
            },
        },
        { $unwind: '$user' },
        {
            $project: {
                userId: '$_id',
                name: { $concat: ['$user.firstName', ' ', '$user.lastName'] },
                email: '$user.email',
                total: 1,
                count: 1,
                currency: 1,
                types: 1,
            },
        },
        { $sort: { total: -1 } },
    ]);

    const totalGiving = memberGiving.reduce((sum, m) => sum + m.total, 0);
    const totalGiftAid = totalGiving * 0.25;

    res.json({
        success: true,
        taxYear: `${year}–${year + 1}`,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        memberCount: memberGiving.length,
        totalGiving,
        totalGiftAid,
        members: memberGiving,
    });
});

// ─────────────────────────────────────────────────────────
// Webhook — Stripe events
// ─────────────────────────────────────────────────────────

const handleWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {

        // ── Payment succeeded ─────────────────────────────
        case 'payment_intent.succeeded': {
            const intent = event.data.object;

            // Mark transaction as completed if it exists in DB
            const tx = await GivingTransaction.findOneAndUpdate(
                { reference: intent.id },
                { status: 'completed', processedAt: new Date() },
                { new: true }
            ).lean();

            if (tx) {
                // ── Notify the member their gift was received ──
                notifyGivingConfirmed({
                    userId: tx.user?.toString(),
                    amount: intent.amount,
                    currency: intent.currency,
                    type: intent.metadata?.givingType,
                    churchName: intent.metadata?.churchName ?? 'your church',
                });

                // ── Notify admins if it is a large gift ───────
                // Threshold: £500 (50000 pence) — adjust as needed
                notifyLargeGiftReceived({
                    churchId: tx.church?.toString(),
                    memberName: intent.metadata?.userName ?? 'A member',
                    amount: intent.amount,
                    currency: intent.currency,
                    threshold: 50000,
                });
            }

            console.log(`✅ Payment succeeded: ${intent.id} — ${intent.amount} ${intent.currency}`);
            break;
        }

        // ── Payment failed ────────────────────────────────
        case 'payment_intent.payment_failed': {
            const intent = event.data.object;
            console.error(`❌ Payment failed: ${intent.id} — ${intent.last_payment_error?.message}`);
            break;
        }

        // ── Stripe account fully verified ─────────────────
        // Fires when the pastor completes Stripe onboarding
        // and charges_enabled switches from false → true
        case 'account.updated': {
            const account = event.data.object;

            // Only act when charges JUST became enabled
            const justEnabled =
                account.charges_enabled &&
                event.data.previous_attributes?.charges_enabled === false;

            if (justEnabled) {
                try {
                    const church = await Church.findOne({
                        'settings.stripeAccountId': account.id,
                    }).populate('createdBy', 'firstName lastName email');

                    if (church) {
                        // Enable giving automatically
                        await Church.findByIdAndUpdate(church._id, {
                            'settings.givingEnabled': true,
                        });

                        // ── Notify the pastor giving is live ──────
                        if (church.createdBy) {
                            notifyStripeVerified({
                                userId: church.createdBy._id.toString(),
                                churchName: church.name,
                            });
                        }

                        console.log(`✅ Stripe verified for ${church.name} — giving enabled`);
                    }
                } catch (err) {
                    // Non-critical — log but do not fail the webhook response
                    console.error('account.updated handler error:', err.message);
                }
            }

            console.log(`Account updated: ${account.id} — charges_enabled: ${account.charges_enabled}`);
            break;
        }

        default:
            console.log(`Unhandled Stripe event: ${event.type}`);
    }

    // Stripe requires a 200 within 30 seconds
    res.json({ received: true });
};

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

module.exports = {
    connectStripe,
    connectStatus,
    disconnectStripe,
    createPaymentIntent,
    confirmPayment,
    myGivingHistory,
    givingOverview,
    allTransactions,
    recordCash,
    handleWebhook,
    giftAidReport,
};