const GivingTransaction = require("../models/GivingTransaction");
const Pledge = require("../models/Pledge");
const Membership = require("../models/Membership");
const Notification = require("../models/Notification");

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).send({ error: true, message });

const PLATFORM_FEE_RATE = parseFloat(process.env.PLATFORM_FEE_RATE || "0.005"); // 0.5%

module.exports = {
  // handles both real gateway payments (pending till webhook confirms)
  // and cash entries an admin logs manually (auto confirmed)
  recordGiving: catchAsync(async (req, res) => {
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
      return errorResponse(res, 400, "type, amount and method are required");
    }
    if (amount <= 0) return errorResponse(res, 400, "Amount must be greater than zero");

    const membership = await Membership.findOne({
      user: req.user._id,
      church: req.params.churchId,
      status: "active",
    });
    if (!membership) return errorResponse(res, 403, "Active membership required to give");

    const platformFeeAmount = parseFloat((amount * PLATFORM_FEE_RATE).toFixed(2));

    const isCash = method === "cash" || method === "bank_transfer_offline";
    const status = isCash ? "success" : "pending";
    const paidAt = isCash ? new Date() : null;

    // RCP-YYYYMMDD-RANDOM
    const receiptNumber = `RCP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const transaction = await GivingTransaction.create({
      church: req.params.churchId,
      membership: membership._id,
      user: req.user._id,
      recordedBy: isCash ? req.user._id : null,
      type,
      amount,
      currency: currency || "NGN",
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

    if (pledgeId && status === "success") {
      await _updatePledgeAmount(pledgeId, amount);
    }

    // if an admin logged this on someone elses behalf, let them know
    if (isCash && req.user._id.toString() !== membership.user.toString()) {
      await Notification.create({
        user: membership.user,
        church: req.params.churchId,
        type: "giving_receipt",
        title: "Giving recorded",
        body: `Your ${type} of ${currency || "NGN"} ${amount.toLocaleString()} has been recorded`,
        data: { screen: "GivingHistory", transactionId: transaction._id },
      });
    }

    return res.status(201).send({ error: false, data: transaction });
  }),

  // paystack/flutterwave webhook, not hit from the mobile app - excluded from auth in the route file
  verifyPayment: catchAsync(async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (secret && signature) {
      const crypto = require("crypto");
      const hash = crypto
        .createHmac("sha512", secret)
        .update(JSON.stringify(req.body))
        .digest("hex");
      if (hash !== signature) {
        return errorResponse(res, 401, "Invalid webhook signature");
      }
    }

    const { event, data } = req.body;
    if (event !== "charge.success") {
      return res.status(200).send({ received: true }); // ack but nothing to do
    }

    const transaction = await GivingTransaction.findOne({
      paymentReference: data.reference,
    });

    if (!transaction) {
      return res.status(200).send({ received: true }); // idempotent, nothing matches
    }
    if (transaction.status === "success") {
      return res.status(200).send({ received: true }); // already handled this one
    }

    transaction.status = "success";
    transaction.gatewayReference = data.id?.toString();
    transaction.gatewayResponse = data;
    transaction.paidAt = new Date(data.paid_at || Date.now());
    await transaction.save();

    if (transaction.pledge) {
      await _updatePledgeAmount(transaction.pledge, transaction.amount);
    }

    await Notification.create({
      user: transaction.user,
      church: transaction.church,
      type: "giving_receipt",
      title: "Payment confirmed",
      body: `Your ${transaction.type} of ${transaction.currency} ${transaction.amount.toLocaleString()} was successful`,
      data: { screen: "GivingHistory", transactionId: transaction._id },
    });

    return res.status(200).send({ received: true });
  }),

  getChurchGiving: catchAsync(async (req, res) => {
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
        .populate("user", "firstName lastName")
        .populate("membership", "membershipNumber")
        .sort({ paidAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      GivingTransaction.countDocuments(filter),
    ]);

    // totals broken down by type for whatever filter is active
    const summary = await GivingTransaction.aggregate([
      { $match: { ...filter, status: "success" } },
      {
        $group: {
          _id: "$type",
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    return res.send({
      error: false,
      total,
      page,
      pages: Math.ceil(total / limit),
      summary,
      data: transactions,
    });
  }),

  getMyGiving: catchAsync(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const membership = await Membership.findOne({
      user: req.user._id,
      church: req.params.churchId,
      status: "active",
    });
    if (!membership) return errorResponse(res, 403, "Active membership required");

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

    // ytd total for the little summary card on the giving screen
    const ytdStart = new Date(new Date().getFullYear(), 0, 1);
    const ytdAgg = await GivingTransaction.aggregate([
      {
        $match: {
          membership: membership._id,
          status: "success",
          paidAt: { $gte: ytdStart },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    return res.send({
      error: false,
      total,
      page,
      pages: Math.ceil(total / limit),
      ytdTotal: ytdAgg[0]?.total || 0,
      data: transactions,
    });
  }),

  // pdf receipt itself is generated by a seperate service, this just returns the data for it
  getReceipt: catchAsync(async (req, res) => {
    const transaction = await GivingTransaction.findOne({
      _id: req.params.transactionId,
      church: req.params.churchId,
      status: "success",
    })
      .populate("user", "firstName lastName email")
      .populate("church", "name address contact");

    if (!transaction) return errorResponse(res, 404, "Transaction not found");

    const isOwner = transaction.user._id.toString() === req.user._id.toString();
    const isAdmin = ["admin", "pastor"].includes(req.membership?.role);
    if (!isOwner && !isAdmin) return errorResponse(res, 403, "Access denied");

    return res.send({ error: false, data: transaction });
  }),

  createPledge: catchAsync(async (req, res) => {
    const { label, targetAmount, currency, dueDate } = req.body;
    if (!label || !targetAmount) {
      return errorResponse(res, 400, "label and targetAmount are required");
    }

    const membership = await Membership.findOne({
      user: req.user._id,
      church: req.params.churchId,
      status: "active",
    });
    if (!membership) return errorResponse(res, 403, "Active membership required");

    const pledge = await Pledge.create({
      church: req.params.churchId,
      membership: membership._id,
      user: req.user._id,
      label,
      targetAmount,
      currency: currency || "NGN",
      dueDate: dueDate ? new Date(dueDate) : undefined,
    });

    return res.status(201).send({ error: false, data: pledge });
  }),

  getMyPledges: catchAsync(async (req, res) => {
    const membership = await Membership.findOne({
      user: req.user._id,
      church: req.params.churchId,
      status: "active",
    });
    if (!membership) return errorResponse(res, 403, "Active membership required");

    const pledges = await Pledge.find({ membership: membership._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.send({ error: false, data: pledges });
  }),

  getChurchPledges: catchAsync(async (req, res) => {
    const filter = { church: req.params.churchId };
    if (req.query.status) filter.status = req.query.status;

    const pledges = await Pledge.find(filter)
      .populate("user", "firstName lastName")
      .sort({ createdAt: -1 })
      .lean();

    const totalPledged = pledges.reduce((s, p) => s + p.targetAmount, 0);
    const totalPaid = pledges.reduce((s, p) => s + p.amountPaid, 0);

    return res.send({ error: false, totalPledged, totalPaid, data: pledges });
  }),
};

// bumps amountPaid on a pledge, flips it to fulfilled once it hits the target
const _updatePledgeAmount = async (pledgeId, amount) => {
  const pledge = await Pledge.findById(pledgeId);
  if (!pledge) return;

  pledge.amountPaid = Math.min(pledge.targetAmount, pledge.amountPaid + amount);
  if (pledge.amountPaid >= pledge.targetAmount) {
    pledge.status = "fulfilled";
    pledge.fulfilledAt = new Date();
  }
  await pledge.save();
};