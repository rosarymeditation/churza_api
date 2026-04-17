const GivingTransaction = require('../models/GivingTransaction');
const Pledge = require('../models/Pledge');
const Membership = require('../models/Membership');
const Notification = require('../models/Notification');

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

const PLATFORM_FEE_RATE = parseFloat(process.env.PLATFORM_FEE_RATE || '0.005'); // 0.5%

// ─────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────

/**
 * POST /api/churches/:churchId/giving
 *
 * Records a new giving transaction.
 *
 * For in-app payments: body includes paymentReference from
 * Paystack/Stripe — status starts as 'pending', confirmed
 * via webhook (see verifyPayment).
 *
 * For cash entries by admin: method = 'cash', status = 'success'.
 *
 * Body: { type, amount, currency, method, paymentReference,
 *         pledgeId, sessionId, note }
 * Auth: active member  (or admin recording cash)
 */
const recordGiving = catchAsync(async (req, res) => {
  const {
    type,
    amount,
    currency,
    method,
    paymentReference,
    pledgeId,
    sessionId,
    note,
  } = req.body;

  if (!type || !amount || !method) {
    return errorResponse(res, 400, 'type, amount and method are required');
  }

  if (amount <= 0) return errorResponse(res, 400, 'Amount must be greater than zero');

  const membership = await Membership.findOne({
    user: req.user._id,
    church: req.params.churchId,
    status: 'active',
  });

  if (!membership) return errorResponse(res, 403, 'Active membership required to give');

  const platformFeeAmount = parseFloat((amount * PLATFORM_FEE_RATE).toFixed(2));

  // Cash entries by admin are auto-confirmed
  const isCash = method === 'cash' || method === 'bank_transfer_offline';
  const status = isCash ? 'success' : 'pending';
  const paidAt = isCash ? new Date() : null;

  // Generate a receipt number: RCP-YYYYMMDD-RANDOM
  const receiptNumber = `RCP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  const transaction = await GivingTransaction.create({
    church: req.params.churchId,
    membership: membership._id,
    user: req.user._id,
    recordedBy: isCash ? req.user._id : null,
    type,
    amount,
    currency: currency || 'NGN',
    method,
    platformFeeAmount,
    platformFeeRate: PLATFORM_FEE_RATE,
    status,
    paymentReference,
    paidAt,
    receiptNumber,
    pledge: pledgeId || null,
    session: sessionId || null,
    note,
  });

  // If linked to a pledge, update amountPaid
  if (pledgeId && status === 'success') {
    await _updatePledgeAmount(pledgeId, amount);
  }

  // Notify member on cash entry (admin entered on their behalf)
  if (isCash && req.user._id.toString() !== membership.user.toString()) {
    await Notification.create({
      user: membership.user,
      church: req.params.churchId,
      type: 'giving_receipt',
      title: 'Giving recorded',
      body: `Your ${type} of ${currency || 'NGN'} ${amount.toLocaleString()} has been recorded`,
      data: { screen: 'GivingHistory', transactionId: transaction._id },
    });
  }

  res.status(201).json({ success: true, transaction });
});

/**
 * POST /api/churches/:churchId/giving/verify
 *
 * Webhook handler called by Paystack/Flutterwave after payment.
 * Verifies the signature, marks the transaction as successful,
 * and updates any linked pledge.
 *
 * This endpoint must be excluded from the auth middleware —
 * it's called by the payment gateway server, not the mobile app.
 *
 * Body: raw Paystack/Flutterwave webhook payload
 */
const verifyPayment = catchAsync(async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (secret && signature) {
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== signature) {
      return errorResponse(res, 401, 'Invalid webhook signature');
    }
  }

  const { event, data } = req.body;

  if (event !== 'charge.success') {
    return res.status(200).json({ received: true }); // acknowledge but don't process
  }

  const transaction = await GivingTransaction.findOne({
    paymentReference: data.reference,
  });

  if (!transaction) {
    return res.status(200).json({ received: true }); // idempotent
  }

  if (transaction.status === 'success') {
    return res.status(200).json({ received: true }); // already processed
  }

  transaction.status = 'success';
  transaction.gatewayReference = data.id?.toString();
  transaction.gatewayResponse = data;
  transaction.paidAt = new Date(data.paid_at || Date.now());
  await transaction.save();

  // Update pledge if linked
  if (transaction.pledge) {
    await _updatePledgeAmount(transaction.pledge, transaction.amount);
  }

  // Notify member
  await Notification.create({
    user: transaction.user,
    church: transaction.church,
    type: 'giving_receipt',
    title: 'Payment confirmed',
    body: `Your ${transaction.type} of ${transaction.currency} ${transaction.amount.toLocaleString()} was successful`,
    data: { screen: 'GivingHistory', transactionId: transaction._id },
  });

  res.status(200).json({ received: true });
});

/**
 * GET /api/churches/:churchId/giving
 *
 * Admin: returns all transactions for the church with filters.
 *
 * Query: ?page=1&limit=20&type=tithe&status=success&from=2025-01-01&to=2025-01-31
 * Auth: admin | pastor
 */
const getChurchGiving = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const filter = { church: req.params.churchId };

  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.from || req.query.to) {
    filter.paidAt = {};
    if (req.query.from) filter.paidAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.paidAt.$lte = new Date(req.query.to);
  }

  const [transactions, total] = await Promise.all([
    GivingTransaction.find(filter)
      .populate('user', 'firstName lastName')
      .populate('membership', 'membershipNumber')
      .sort({ paidAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    GivingTransaction.countDocuments(filter),
  ]);

  // Summary totals for the current filter
  const summary = await GivingTransaction.aggregate([
    { $match: { ...filter, status: 'success' } },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    summary,
    transactions,
  });
});

/**
 * GET /api/churches/:churchId/giving/me
 *
 * Member views their own giving history.
 *
 * Query: ?page=1&limit=20&type=tithe
 * Auth: active member
 */
const getMyGiving = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const membership = await Membership.findOne({
    user: req.user._id,
    church: req.params.churchId,
    status: 'active',
  });

  if (!membership) return errorResponse(res, 403, 'Active membership required');

  const filter = { membership: membership._id };
  if (req.query.type) filter.type = req.query.type;

  const [transactions, total] = await Promise.all([
    GivingTransaction.find(filter)
      .sort({ paidAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    GivingTransaction.countDocuments(filter),
  ]);

  // Year-to-date total
  const ytdStart = new Date(new Date().getFullYear(), 0, 1);
  const ytdAgg = await GivingTransaction.aggregate([
    {
      $match: {
        membership: membership._id,
        status: 'success',
        paidAt: { $gte: ytdStart },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    ytdTotal: ytdAgg[0]?.total || 0,
    transactions,
  });
});

/**
 * GET /api/churches/:churchId/giving/:transactionId/receipt
 *
 * Returns the receipt data for a transaction.
 * (PDF generation via a separate service is wired to receiptUrl.)
 *
 * Auth: the member who gave, or admin
 */
const getReceipt = catchAsync(async (req, res) => {
  const transaction = await GivingTransaction.findOne({
    _id: req.params.transactionId,
    church: req.params.churchId,
    status: 'success',
  })
    .populate('user', 'firstName lastName email')
    .populate('church', 'name address contact');

  if (!transaction) return errorResponse(res, 404, 'Transaction not found');

  // Only the giving member or an admin can view
  const isOwner = transaction.user._id.toString() === req.user._id.toString();
  const isAdmin = ['admin', 'pastor'].includes(req.membership?.role);
  if (!isOwner && !isAdmin) return errorResponse(res, 403, 'Access denied');

  res.status(200).json({ success: true, receipt: transaction });
});

// ─────────────────────────────────────────────────────────
// Pledges
// ─────────────────────────────────────────────────────────

/**
 * POST /api/churches/:churchId/pledges
 *
 * Creates a new pledge for the authenticated member.
 *
 * Body: { label, targetAmount, currency, dueDate }
 * Auth: active member
 */
const createPledge = catchAsync(async (req, res) => {
  const { label, targetAmount, currency, dueDate } = req.body;

  if (!label || !targetAmount) {
    return errorResponse(res, 400, 'label and targetAmount are required');
  }

  const membership = await Membership.findOne({
    user: req.user._id,
    church: req.params.churchId,
    status: 'active',
  });

  if (!membership) return errorResponse(res, 403, 'Active membership required');

  const pledge = await Pledge.create({
    church: req.params.churchId,
    membership: membership._id,
    user: req.user._id,
    label,
    targetAmount,
    currency: currency || 'NGN',
    dueDate: dueDate ? new Date(dueDate) : undefined,
  });

  res.status(201).json({ success: true, pledge });
});

/**
 * GET /api/churches/:churchId/pledges/me
 *
 * Member views their own pledges.
 *
 * Auth: active member
 */
const getMyPledges = catchAsync(async (req, res) => {
  const membership = await Membership.findOne({
    user: req.user._id,
    church: req.params.churchId,
    status: 'active',
  });

  if (!membership) return errorResponse(res, 403, 'Active membership required');

  const pledges = await Pledge.find({ membership: membership._id })
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ success: true, pledges });
});

/**
 * GET /api/churches/:churchId/pledges
 *
 * Admin views all pledges for the church.
 *
 * Query: ?status=active
 * Auth: admin | pastor
 */
const getChurchPledges = catchAsync(async (req, res) => {
  const filter = { church: req.params.churchId };
  if (req.query.status) filter.status = req.query.status;

  const pledges = await Pledge.find(filter)
    .populate('user', 'firstName lastName')
    .sort({ createdAt: -1 })
    .lean();

  const totalPledged = pledges.reduce((s, p) => s + p.targetAmount, 0);
  const totalPaid = pledges.reduce((s, p) => s + p.amountPaid, 0);

  res.status(200).json({ success: true, totalPledged, totalPaid, pledges });
});

// ─────────────────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────────────────

const _updatePledgeAmount = async (pledgeId, amount) => {
  const pledge = await Pledge.findById(pledgeId);
  if (!pledge) return;
  pledge.amountPaid = Math.min(pledge.targetAmount, pledge.amountPaid + amount);
  if (pledge.amountPaid >= pledge.targetAmount) {
    pledge.status = 'fulfilled';
    pledge.fulfilledAt = new Date();
  }
  await pledge.save();
};

module.exports = {
  recordGiving,
  verifyPayment,
  getChurchGiving,
  getMyGiving,
  getReceipt,
  createPledge,
  getMyPledges,
  getChurchPledges,
};
