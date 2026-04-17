require('dotenv').config();
const stripe = require('../config/stripe');
const Church = require('../models/Church');
const mongoose = require('mongoose');
const Membership = require('../models/Membership');
const GivingTransaction = require('../models/GivingTransaction');
const catchAsync = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

// ─────────────────────────────────────────────────────────
// Stripe Connect — Admin onboarding
// ─────────────────────────────────────────────────────────

/**
 * POST /api/payments/:churchId/connect
 *
 * Admin initiates Stripe Connect onboarding.
 * Creates an Express account for the church and returns
 * an onboarding URL for the admin to complete KYC.
 *
 * Body: { email, country }
 * Auth: protect + requireChurchRole('admin')
 */
const connectStripe = catchAsync(async (req, res) => {
    const church = await Church.findById(req.params.churchId);
    if (!church) return errorResponse(res, 404, 'Church not found');

    // If already connected — return existing status
    if (church.settings.stripeAccountId) {
        const account = await stripe.accounts.retrieve(
            church.settings.stripeAccountId
        );
        if (account.charges_enabled) {
            return res.json({
                success: true,
                connected: true,
                message: 'Stripe already connected',
            });
        }
    }

    // Create Stripe Express account for the church
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

    // Save account ID to church settings
    await Church.findByIdAndUpdate(req.params.churchId, {
        'settings.stripeAccountId': account.id,
        'settings.activeGateway': 'stripe',
    });

    // Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: "https://churza.app/stripe/refresh",
        return_url: 'https://churza.app/stripe/return',
        type: 'account_onboarding',
    });

    res.status(200).json({
        success: true,
        onboardingUrl: accountLink.url,
        accountId: account.id,
    });
});

/**
 * GET /api/payments/:churchId/connect/status
 *
 * Check if the church Stripe account is fully onboarded.
 * Also enables giving if account is ready.
 *
 * Auth: protect + requireChurchRole('admin', 'pastor')
 */
const connectStatus = catchAsync(async (req, res) => {
    const church = await Church.findById(req.params.churchId);
    if (!church) return errorResponse(res, 404, 'Church not found');

    if (!church.settings?.stripeAccountId) {
        return res.json({
            success: true,
            connected: false,
            message: 'No Stripe account linked',
        });
    }

    const account = await stripe.accounts.retrieve(
        church.settings.stripeAccountId
    );

    const ready = account.charges_enabled && account.payouts_enabled;

    // Auto-enable giving once account is ready
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

/**
 * DELETE /api/payments/:churchId/connect
 *
 * Admin disconnects Stripe from the church.
 *
 * Auth: protect + requireChurchRole('admin')
 */
const disconnectStripe = catchAsync(async (req, res) => {
    const church = await Church.findById(req.params.churchId);
    if (!church) return errorResponse(res, 404, 'Church not found');

    if (church.settings?.stripeAccountId) {
        // Deauthorize the account from the platform
        await stripe.oauth.deauthorize({
            client_id: process.env.STRIPE_CLIENT_ID,
            stripe_user_id: church.settings.stripeAccountId,
        }).catch(() => { }); // non-critical if this fails
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

/**
 * POST /api/payments/:churchId/intent
 *
 * Member initiates a payment.
 * Creates a Stripe PaymentIntent and returns clientSecret
 * for the Flutter Stripe SDK to present the payment sheet.
 *
 * Body: { amount, currency, type }
 * type: 'tithe' | 'offering' | 'pledge' | 'special'
 * amount: in smallest currency unit (pence for GBP, kobo for NGN)
 *
 * Auth: protect + requireActiveMembership
 */
const createPaymentIntent = catchAsync(async (req, res) => {
    const { amount, currency, type, note } = req.body;

    if (!amount || amount < 100) {
        return errorResponse(res, 400, 'Minimum amount is 1.00');
    }

    const church = await Church.findById(req.params.churchId);
    if (!church) return errorResponse(res, 404, 'Church not found');

    if (!church.settings?.givingEnabled) {
        return errorResponse(res, 400, 'Online giving is not enabled for this church');
    }

    if (!church.settings?.stripeAccountId) {
        return errorResponse(res, 400, 'Church has not connected a payment account');
    }

    // 1.5% platform fee
    const platformFee = Math.round(amount * 0.015);

    const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: (currency || church.settings.currency || 'gbp').toLowerCase(),
        application_fee_amount: platformFee,
        transfer_data: {
            destination: church.settings.stripeAccountId,
        },
        metadata: {
            churchId: church._id.toString(),
            churchName: church.name,
            userId: req.user._id.toString(),
            userName: `${req.user.firstName} ${req.user.lastName}`,
            givingType: type || 'offering',
            note: note || '',
        },
        description: `${type || 'Offering'} — ${church.name}`,
    });

    res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
        currency: paymentIntent.currency,
    });
});

/**
 * POST /api/payments/:churchId/confirm
 *
 * Called after Flutter confirms payment successfully.
 * Verifies with Stripe that the payment succeeded, then
 * saves the transaction to the database.
 *
 * Body: { paymentIntentId, amount, currency, type, note }
 * Auth: protect + requireActiveMembership
 */
const confirmPayment = catchAsync(async (req, res) => {
    const { paymentIntentId, amount, currency, type, note } = req.body;

    if (!paymentIntentId) {
        return errorResponse(res, 400, 'Payment intent ID required');
    }

    // Verify with Stripe — never trust the client
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (intent.status !== 'succeeded') {
        return errorResponse(res, 400, `Payment not confirmed — status: ${intent.status}`);
    }

    // Check for duplicate confirmation
    const existing = await GivingTransaction.findOne({ reference: paymentIntentId });
    if (existing) {
        return res.json({ success: true, transaction: existing, duplicate: true });
    }

    const transaction = await GivingTransaction.create({
        church: req.params.churchId,
        user: req.user._id,
        amount: amount / 100,             // pence → pounds
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

/**
 * GET /api/payments/:churchId/history/me
 *
 * Member's own giving history.
 *
 * Query: ?page=1&limit=20
 * Auth: protect + requireActiveMembership
 */
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

    // Sum up totals by type
    const totals = await GivingTransaction.aggregate([
        {
            $match: {
                church: new mongoose.Types.ObjectId(req.params.churchId),
                user: new mongoose.Types.ObjectId(req.user._id),
                status: 'completed',
            },
        },
        {
            $group: {
                _id: '$type',
                total: { $sum: '$amount' },
                count: { $sum: 1 },
            },
        },
    ]);

    res.json({ success: true, total, page, transactions, totals });
});

// ─────────────────────────────────────────────────────────
// Admin — Church giving overview
// ─────────────────────────────────────────────────────────

/**
 * GET /api/payments/:churchId/overview
 *
 * Admin giving dashboard — totals by type and month.
 *
 * Query: ?month=2026-03
 * Auth: protect + requireChurchRole('admin', 'pastor')
 */
const givingOverview = catchAsync(async (req, res) => {
    const now = new Date();
    const monthStr = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [year, month] = monthStr.split('-').map(Number);
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 1);

    const [monthly, allTime, recent] = await Promise.all([
        // This month totals by type
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

        // All time total
        GivingTransaction.aggregate([
            {
                $match: {
                    church: new mongoose.Types.ObjectId(req.params.churchId),
                    status: 'completed',
                },
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
        ]),

        // Recent 10 transactions
        GivingTransaction.find({
            church: req.params.churchId,
            status: 'completed',
        })
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

/**
 * GET /api/payments/:churchId/transactions
 *
 * Paginated full transaction list for admin.
 *
 * Query: ?page=1&limit=20&type=tithe&userId=xxx
 * Auth: protect + requireChurchRole('admin', 'pastor')
 */
const allTransactions = catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {
        church: req.params.churchId,
        status: 'completed',
    };
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

/**
 * POST /api/payments/:churchId/cash
 *
 * Admin records a cash giving manually.
 *
 * Body: { userId, amount, currency, type, note, date }
 * Auth: protect + requireChurchRole('admin', 'pastor', 'worker')
 */
const recordCash = catchAsync(async (req, res) => {
    const { userId, amount, currency, type, note, date } = req.body;

    if (!amount || amount <= 0) {
        return errorResponse(res, 400, 'Valid amount required');
    }

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
// Webhook — Stripe events
// ─────────────────────────────────────────────────────────

/**
 * POST /api/payments/webhook
 *
 * Stripe sends events here — payment_intent.succeeded etc.
 * No auth — Stripe signs the request instead.
 * Must use raw body (express.raw middleware on this route).
 */
const handleWebhook = (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,                              // raw buffer
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
        case 'payment_intent.succeeded': {
            const intent = event.data.object;
            console.log(`✅ Payment succeeded: ${intent.id} — ${intent.amount} ${intent.currency}`);
            // Optionally save here if Flutter confirmPayment call failed
            break;
        }
        case 'payment_intent.payment_failed': {
            const intent = event.data.object;
            console.error(`❌ Payment failed: ${intent.id} — ${intent.last_payment_error?.message}`);
            break;
        }
        case 'account.updated': {
            const account = event.data.object;
            console.log(`Account updated: ${account.id} — charges_enabled: ${account.charges_enabled}`);
            break;
        }
        default:
            console.log(`Unhandled Stripe event: ${event.type}`);
    }

    res.json({ received: true });
};

// ─────────────────────────────────────────────────────────
// Lazy model import — avoids circular dependency issues
// ─────────────────────────────────────────────────────────

const getGivingTransaction = () => {
    if (!GivingTransaction) {
        GivingTransaction = require('../models/GivingTransaction');
    }
    return GivingTransaction;
};

// Patch all functions that use GivingTransaction to use the getter
// (This is handled inline above via the variable reference)
/**
 * GET /api/payments/:churchId/gift-aid
 *
 * Generates Gift Aid report data for the church.
 * Returns member giving totals for a given tax year.
 *
 * Query: ?year=2025  (start year of UK tax year)
 * Auth: protect + requireChurchRole('admin', 'pastor')
 */
const giftAidReport = catchAsync(async (req, res) => {
    const GivingTransaction = require('../models/GivingTransaction');
    const Membership = require('../models/Membership');
   

    const year = parseInt(req.query.year) || new Date().getFullYear();

    // UK tax year: 6 April year → 5 April year+1
    const startDate = new Date(year, 3, 6);      // 6 April
    const endDate = new Date(year + 1, 3, 5,   // 5 April next year
        23, 59, 59);

    // Aggregate giving by member for the tax year
    const memberGiving = await GivingTransaction.aggregate([
        {
            $match: {
                church:  mongoose.Types.ObjectId(req.params.churchId),
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
                name: {
                    $concat: ['$user.firstName', ' ', '$user.lastName'],
                },
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
    giftAidReport
};