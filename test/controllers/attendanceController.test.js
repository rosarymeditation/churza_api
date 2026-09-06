jest.mock("../../models/Attendance");
jest.mock("../../models/AttendanceSession");
jest.mock("../../models/Membership");
jest.mock("../../utils/churchNotifications", () => ({
  notifyCheckInOpened: jest.fn(),
}));

const Attendance = require("../../models/Attendance");
const AttendanceSession = require("../../models/AttendanceSession");
const Membership = require("../../models/Membership");
const controller = require("../../controllers/attendanceController");

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
    user: { _id: "user1" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("attendanceController.checkIn", () => {
  it("blocks check-in when there's no active session for the church", async () => {
    AttendanceSession.findOne.mockResolvedValue(null);

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.checkIn(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Attendance.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member trying to check in to an active session", async () => {
    AttendanceSession.findOne.mockResolvedValue({ _id: "session1", serviceType: "sunday" });
    Membership.findOne.mockResolvedValue(null);

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.checkIn(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Attendance.create).not.toHaveBeenCalled();
  });

  it("returns the existing record instead of creating a duplicate for a same-day check-in", async () => {
    AttendanceSession.findOne.mockResolvedValue({ _id: "session1", serviceType: "sunday" });
    Membership.findOne.mockResolvedValue({ _id: "membership1" });
    const existingRecord = { _id: "att1", checkedInAt: new Date() };
    Attendance.findOne.mockResolvedValue(existingRecord);

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.checkIn(req, res);

    expect(Attendance.create).not.toHaveBeenCalled();
    const payload = res.send.mock.calls[0][0];
    expect(payload.alreadyCheckedIn).toBe(true);
    expect(payload.data).toBe(existingRecord);
  });

  it("creates a new attendance record and increments the session's attendeeCount", async () => {
    AttendanceSession.findOne.mockResolvedValue({ _id: "session1", serviceType: "sunday" });
    Membership.findOne.mockResolvedValue({ _id: "membership1" });
    Attendance.findOne.mockResolvedValue(null); // no prior check-in today
    Attendance.create.mockResolvedValue({ _id: "att1" });
    AttendanceSession.findByIdAndUpdate.mockResolvedValue({});

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.checkIn(req, res);

    expect(Attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        church: "church1",
        user: "user1",
        membership: "membership1",
        method: "app",
      })
    );
    expect(AttendanceSession.findByIdAndUpdate).toHaveBeenCalledWith(
      "session1",
      { $inc: { attendeeCount: 1 } }
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const payload = res.send.mock.calls[0][0];
    expect(payload.alreadyCheckedIn).toBe(false);
  });
});

describe("attendanceController.usherCheckIn", () => {
  it("rejects when there's no active session", async () => {
    AttendanceSession.findOne.mockResolvedValue(null);

    const req = mockReq({ params: { churchId: "church1" }, body: { userId: "member1" } });
    const res = mockRes();

    await controller.usherCheckIn(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects checking in someone who isn't an active member of this church", async () => {
    AttendanceSession.findOne.mockResolvedValue({ _id: "session1", serviceType: "sunday" });
    Membership.findOne.mockResolvedValue(null);

    const req = mockReq({ params: { churchId: "church1" }, body: { userId: "notamember" } });
    const res = mockRes();

    await controller.usherCheckIn(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("marks an already-checked-in member without creating a duplicate", async () => {
    AttendanceSession.findOne.mockResolvedValue({ _id: "session1", serviceType: "sunday" });
    Membership.findOne.mockResolvedValue({ _id: "membership1" });
    Attendance.findOne.mockResolvedValue({ _id: "att1" }); // already checked in

    const req = mockReq({ params: { churchId: "church1" }, body: { userId: "member1" } });
    const res = mockRes();

    await controller.usherCheckIn(req, res);

    expect(Attendance.create).not.toHaveBeenCalled();
    const payload = res.send.mock.calls[0][0];
    expect(payload.alreadyCheckedIn).toBe(true);
  });

  it("records a manual check-in with method 'usher'", async () => {
    AttendanceSession.findOne.mockResolvedValue({ _id: "session1", serviceType: "sunday" });
    Membership.findOne.mockResolvedValue({ _id: "membership1" });
    Attendance.findOne.mockResolvedValue(null);
    Attendance.create.mockResolvedValue({ _id: "att1" });
    AttendanceSession.findByIdAndUpdate.mockResolvedValue({});

    const req = mockReq({ params: { churchId: "church1" }, body: { userId: "member1" } });
    const res = mockRes();

    await controller.usherCheckIn(req, res);

    expect(Attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({ method: "usher", user: "member1" })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("attendanceController.startSession", () => {
  it("closes any existing active session before opening a new one", async () => {
    AttendanceSession.updateMany.mockResolvedValue({});
    AttendanceSession.create.mockResolvedValue({ _id: "session2", title: "Sunday Service" });

    const req = mockReq({ params: { churchId: "church1" }, body: {} });
    const res = mockRes();

    await controller.startSession(req, res);

    expect(AttendanceSession.updateMany).toHaveBeenCalledWith(
      { church: "church1", isActive: true },
      expect.objectContaining({ isActive: false })
    );
    expect(AttendanceSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true, title: "Sunday Service" })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("attendanceController.endSession", () => {
  it("returns 404 when there's no active session to end", async () => {
    AttendanceSession.findOneAndUpdate.mockResolvedValue(null);

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.endSession(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("ends the active session and stamps endedAt", async () => {
    AttendanceSession.findOneAndUpdate.mockResolvedValue({ _id: "session1", isActive: false });

    const req = mockReq({ params: { churchId: "church1" } });
    const res = mockRes();

    await controller.endSession(req, res);

    expect(AttendanceSession.findOneAndUpdate).toHaveBeenCalledWith(
      { church: "church1", isActive: true },
      expect.objectContaining({ isActive: false }),
      { new: true }
    );
  });
});
