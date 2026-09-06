jest.mock("jsonwebtoken");
jest.mock("../../models/User");
jest.mock("../../models/Membership");

const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const Membership = require("../../models/Membership");
const controller = require("../../controllers/userController");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(overrides = {}) {
  return { body: {}, params: {}, query: {}, ...overrides };
}

// userController's catchAsync doesn't return its inner promise (missing an
// implicit return - braces around the arrow body swallow it), so awaiting
// the controller call directly doesn't actually wait for the async work to
// finish. Flushing a macrotask tick lets the microtask queue (all the
// chained awaits inside the real handler) fully drain first.
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  jwt.sign.mockReturnValue("fake-jwt-token");
});

describe("userController.register", () => {
  it("rejects when required fields are missing", async () => {
    const req = mockReq({ body: { email: "a@b.com" } });
    const res = mockRes();

    await controller.register(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(User.create).not.toHaveBeenCalled();
  });

  it("rejects a password under 8 characters", async () => {
    const req = mockReq({
      body: { firstName: "A", lastName: "B", email: "a@b.com", password: "short" },
    });
    const res = mockRes();

    await controller.register(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects an invalid userIntent value", async () => {
    const req = mockReq({
      body: {
        firstName: "A", lastName: "B", email: "a@b.com",
        password: "password123", userIntent: "wizard",
      },
    });
    const res = mockRes();

    await controller.register(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects when the email is already registered", async () => {
    User.findOne.mockResolvedValue({ _id: "existing" });

    const req = mockReq({
      body: { firstName: "A", lastName: "B", email: "a@b.com", password: "password123" },
    });
    const res = mockRes();

    await controller.register(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(409);
    expect(User.create).not.toHaveBeenCalled();
  });

  it("routes a member-intent signup to 'join_church' with hasChurch false", async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      _id: "user1",
      toSafeObject: () => ({ _id: "user1", firstName: "A" }),
    });

    const req = mockReq({
      body: {
        firstName: "A", lastName: "B", email: "a@b.com",
        password: "password123", userIntent: "member",
      },
    });
    const res = mockRes();

    await controller.register(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = res.send.mock.calls[0][0];
    expect(payload.nextScreen).toBe("join_church");
    expect(payload.hasChurch).toBe(false);
  });

  it("routes an admin-intent signup to 'register_church' and sets systemRole admin", async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      _id: "user1",
      toSafeObject: () => ({ _id: "user1" }),
    });

    const req = mockReq({
      body: {
        firstName: "A", lastName: "B", email: "a@b.com",
        password: "password123", userIntent: "admin",
      },
    });
    const res = mockRes();

    await controller.register(req, res);
    await flushPromises();

    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ systemRole: "admin" })
    );
    const payload = res.send.mock.calls[0][0];
    expect(payload.nextScreen).toBe("register_church");
  });
});

describe("userController.login", () => {
  it("rejects when email or password is missing", async () => {
    const req = mockReq({ body: { email: "a@b.com" } });
    const res = mockRes();

    await controller.login(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects invalid credentials without revealing whether the account exists", async () => {
    User.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });

    const req = mockReq({ body: { email: "nobody@b.com", password: "wrong" } });
    const res = mockRes();

    await controller.login(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a deactivated account even with correct credentials", async () => {
    User.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        isActive: false,
        comparePassword: jest.fn().mockResolvedValue(true),
      }),
    });

    const req = mockReq({ body: { email: "a@b.com", password: "correct" } });
    const res = mockRes();

    await controller.login(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("routes to 'join_church' when the user has no membership at all", async () => {
    const userDoc = {
      _id: "user1",
      isActive: true,
      comparePassword: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockResolvedValue(true),
      toSafeObject: () => ({ _id: "user1" }),
    };
    User.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(userDoc) });
    Membership.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      }),
    });

    const req = mockReq({ body: { email: "a@b.com", password: "correct" } });
    const res = mockRes();

    await controller.login(req, res);
    await flushPromises();

    const payload = res.send.mock.calls[0][0];
    expect(payload.nextScreen).toBe("join_church");
    expect(payload.hasChurch).toBe(false);
  });

  it("routes to 'pending_approval' when membership status is pending", async () => {
    const userDoc = {
      _id: "user1",
      isActive: true,
      comparePassword: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockResolvedValue(true),
      toSafeObject: () => ({ _id: "user1" }),
    };
    User.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(userDoc) });
    Membership.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ status: "pending", role: "member", church: "church1" }),
        }),
      }),
    });

    const req = mockReq({ body: { email: "a@b.com", password: "correct" } });
    const res = mockRes();

    await controller.login(req, res);
    await flushPromises();

    const payload = res.send.mock.calls[0][0];
    expect(payload.nextScreen).toBe("pending_approval");
    expect(payload.hasChurch).toBe(true);
    expect(payload.activeMembershipId).toBeNull(); // not active yet
  });

  it("routes an active admin/pastor member to 'admin_home' and includes activeChurchId", async () => {
    const userDoc = {
      _id: "user1",
      isActive: true,
      comparePassword: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockResolvedValue(true),
      toSafeObject: () => ({ _id: "user1" }),
    };
    User.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(userDoc) });
    Membership.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: "membership1", status: "active", role: "pastor", church: "church1",
          }),
        }),
      }),
    });

    const req = mockReq({ body: { email: "a@b.com", password: "correct" } });
    const res = mockRes();

    await controller.login(req, res);
    await flushPromises();

    const payload = res.send.mock.calls[0][0];
    expect(payload.nextScreen).toBe("admin_home");
    expect(payload.activeMembershipId).toBe("membership1");
    expect(payload.activeChurchId).toBe("church1");
  });

  it("routes a plain active member to 'member_home', not 'admin_home'", async () => {
    const userDoc = {
      _id: "user1",
      isActive: true,
      comparePassword: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockResolvedValue(true),
      toSafeObject: () => ({ _id: "user1" }),
    };
    User.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(userDoc) });
    Membership.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: "membership1", status: "active", role: "member", church: "church1",
          }),
        }),
      }),
    });

    const req = mockReq({ body: { email: "a@b.com", password: "correct" } });
    const res = mockRes();

    await controller.login(req, res);
    await flushPromises();

    const payload = res.send.mock.calls[0][0];
    expect(payload.nextScreen).toBe("member_home");
  });
});

describe("userController.changePassword", () => {
  it("rejects a new password under 8 characters", async () => {
    const req = mockReq({
      user: { _id: "user1" },
      body: { currentPassword: "old12345", newPassword: "short" },
    });
    const res = mockRes();

    await controller.changePassword(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects when the current password doesn't match", async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        comparePassword: jest.fn().mockResolvedValue(false),
      }),
    });

    const req = mockReq({
      user: { _id: "user1" },
      body: { currentPassword: "wrongpass", newPassword: "newpassword123" },
    });
    const res = mockRes();

    await controller.changePassword(req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("updates the password and returns a fresh token on success", async () => {
    const userDoc = {
      _id: "user1",
      comparePassword: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockResolvedValue(true),
      toSafeObject: () => ({ _id: "user1" }),
    };
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(userDoc) });

    const req = mockReq({
      user: { _id: "user1" },
      body: { currentPassword: "old12345", newPassword: "newpassword123" },
    });
    const res = mockRes();

    await controller.changePassword(req, res);
    await flushPromises();

    expect(userDoc.passwordHash).toBe("newpassword123");
    expect(userDoc.save).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});