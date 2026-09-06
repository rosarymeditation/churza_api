jest.mock("../../config/stripe");
jest.mock("../../models/Church");
jest.mock("../../models/GivingTransaction");

const stripe = require("../../config/stripe");
const Church = require("../../models/Church");
const GivingTransaction = require("../../models/GivingTransaction");
const controller = require("../../controllers/paymentController");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(overrides = {}) {
  return {
    body: {},
    params: {},
    query: {},
    user: { _id: "user1", email: "a@b.com", firstName: "Alice", lastName: "Smith" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("paymentController.createPaymentIntent", () => {
  it("rejects amounts below the minimum (£1.00 / 100 pence)", async () => {
    const req = mockReq({ params: { churchId: "church1" }, body: { amount: 50, type: "tithe" } });
    const res = mockRes();

    await controller.createPaymentIntent(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("rejects a non-integer amount", async () => {
    const req = mockReq({ params: { churchId: "church1" }, body: { amount: 100.5 } });
    const res = mockRes();

    await controller.createPaymentIntent(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("blocks giving when the church hasn't enabled online giving", async () => {
    Church.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: "church1",
        name: "Grace Chapel",
        settings: { givingEnabled: false, stripeAccountId: "acct_123" },
      }),
    });

    const req = mockReq({ params: { churchId: "church1" }, body: { amount: 1000, type: "tithe" } });
    const res = mockRes();

    await controller.createPaymentIntent(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("blocks giving when the church has no Stripe account connected", async () => {
    Church.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: "church1",
        name: "Grace Chapel",
        settings: { givingEnabled: true, stripeAccountId: null },
      }),
    });

    const req = mockReq({ params: { churchId: "church1" }, body: { amount: 1000, type: "tithe" } });
    const res = mockRes();

    await controller.createPaymentIntent(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("creates a payment intent with the platform fee applied via transfer_data", async () => {
    Church.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: "church1",
        name: "Grace Chapel",
        settings: { givingEnabled: true, stripeAccountId: "acct_123", currency: "gbp" },
      }),
    });
    stripe.paymentIntents.create.mockResolvedValue({
      client_secret: "secret_abc",
      id: "pi_123",
      currency: "gbp",
    });

    const req = mockReq({
      params: { churchId: "church1" },
      body: { amount: 10000, type: "tithe" }, // £100.00
    });
    const res = mockRes();

    await controller.createPaymentIntent(req, res);

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 10000,
        transfer_data: { destination: "acct_123" },
        // 1.5% of 10000 = 150, above the 30p minimum, so fee should be 150
        application_fee_amount: 150,
      })
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it("applies the minimum platform fee floor on small giving amounts", async () => {
    Church.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: "church1",
        name: "Grace Chapel",
        settings: { givingEnabled: true, stripeAccountId: "acct_123" },
      }),
    });
    stripe.paymentIntents.create.mockResolvedValue({
      client_secret: "secret_abc",
      id: "pi_123",
      currency: "gbp",
    });

    // 1.5% of 500 = 7.5 -> rounds to 8, well under the 30p (30 pence) floor
    const req = mockReq({
      params: { churchId: "church1" },
      body: { amount: 500, type: "offering" },
    });
    const res = mockRes();

    await controller.createPaymentIntent(req, res);

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ application_fee_amount: 30 })
    );
  });

  it("falls back to 'offering' as the giving type when an invalid type is sent", async () => {
    Church.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: "church1",
        name: "Grace Chapel",
        settings: { givingEnabled: true, stripeAccountId: "acct_123" },
      }),
    });
    stripe.paymentIntents.create.mockResolvedValue({
      client_secret: "secret_abc",
      id: "pi_123",
      currency: "gbp",
    });

    const req = mockReq({
      params: { churchId: "church1" },
      body: { amount: 1000, type: "not_a_real_type" },
    });
    const res = mockRes();

    await controller.createPaymentIntent(req, res);

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ givingType: "offering" }),
      })
    );
  });
});

describe("paymentController.confirmPayment", () => {
  it("rejects when paymentIntentId is missing", async () => {
    const req = mockReq({ params: { churchId: "church1" }, body: {} });
    const res = mockRes();

    await controller.confirmPayment(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("rejects when the Stripe payment intent hasn't actually succeeded", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ status: "requires_payment_method" });

    const req = mockReq({
      params: { churchId: "church1" },
      body: { paymentIntentId: "pi_123", amount: 1000 },
    });
    const res = mockRes();

    await controller.confirmPayment(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(GivingTransaction.create).not.toHaveBeenCalled();
  });

  it("does not double-record a transaction that was already confirmed", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded" });
    GivingTransaction.findOne.mockResolvedValue({ _id: "existing_tx" });

    const req = mockReq({
      params: { churchId: "church1" },
      body: { paymentIntentId: "pi_123", amount: 1000 },
    });
    const res = mockRes();

    await controller.confirmPayment(req, res);

    expect(GivingTransaction.create).not.toHaveBeenCalled();
    const payload = res.send.mock.calls[0][0];
    expect(payload.duplicate).toBe(true);
  });

  it("records a new transaction converting pence to a decimal amount", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded" });
    GivingTransaction.findOne.mockResolvedValue(null);
    GivingTransaction.create.mockResolvedValue({ _id: "tx1", amount: 100 });

    const req = mockReq({
      params: { churchId: "church1" },
      body: { paymentIntentId: "pi_123", amount: 10000, currency: "gbp", type: "tithe" },
    });
    const res = mockRes();

    await controller.confirmPayment(req, res);

    expect(GivingTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100, // 10000 pence -> £100.00
        currency: "GBP",
        status: "completed",
        method: "stripe",
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("paymentController.connectStatus", () => {
  it("reports not connected when the church has no Stripe account at all", async () => {
    Church.findById.mockResolvedValue({
      _id: "church1",
      settings: {},
    });

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.connectStatus(req, res);

    const payload = res.send.mock.calls[0][0];
    expect(payload.connected).toBe(false);
  });

  it("flips givingEnabled on once charges and payouts both become enabled", async () => {
    Church.findById.mockResolvedValue({
      _id: "church1",
      settings: { stripeAccountId: "acct_123", givingEnabled: false },
    });
    stripe.accounts.retrieve.mockResolvedValue({
      id: "acct_123",
      charges_enabled: true,
      payouts_enabled: true,
      requirements: { currently_due: [] },
    });
    Church.findByIdAndUpdate.mockResolvedValue({});

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.connectStatus(req, res);

    expect(Church.findByIdAndUpdate).toHaveBeenCalledWith(
      "church1",
      { "settings.givingEnabled": true }
    );
    const payload = res.send.mock.calls[0][0];
    expect(payload.connected).toBe(true);
  });
});
