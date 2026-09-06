const CellGroup = require("../models/CellGroup");
const Membership = require("../models/Membership");

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).send({ error: true, message });

module.exports = {
  createCellGroup: catchAsync(async (req, res) => {
    if (!req.body.name) return errorResponse(res, 400, "Cell group name is required");

    const cellGroup = await CellGroup.create({
      church: req.params.churchId,
      ...req.body,
    });

    // if a leader got assigned on creation, flip their membership role too
    if (req.body.leader) {
      await Membership.findByIdAndUpdate(req.body.leader, {
        role: "cell_leader",
        cellGroup: cellGroup._id,
      });
    }

    return res.status(201).send({ error: false, data: cellGroup });
  }),

  getCellGroups: catchAsync(async (req, res) => {
    const filter = { church: req.params.churchId, isActive: true };
    if (req.query.zone) filter.zone = new RegExp(req.query.zone, "i");

    const cellGroups = await CellGroup.find(filter)
      .populate({
        path: "leader",
        populate: { path: "user", select: "firstName lastName photoUrl" },
      })
      .sort({ name: 1 })
      .lean();

    return res.send({ error: false, total: cellGroups.length, data: cellGroups });
  }),

  getCellGroup: catchAsync(async (req, res) => {
    const cellGroup = await CellGroup.findOne({
      _id: req.params.cellGroupId,
      church: req.params.churchId,
    }).populate({
      path: "leader",
      populate: { path: "user", select: "firstName lastName photoUrl phone" },
    });

    if (!cellGroup) return errorResponse(res, 404, "Cell group not found");

    const members = await Membership.find({
      church: req.params.churchId,
      cellGroup: cellGroup._id,
      status: "active",
    })
      .populate("user", "firstName lastName photoUrl phone")
      .lean();

    return res.send({ error: false, data: { cellGroup, members } });
  }),

  updateCellGroup: catchAsync(async (req, res) => {
    const cellGroup = await CellGroup.findOneAndUpdate(
      { _id: req.params.cellGroupId, church: req.params.churchId },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!cellGroup) return errorResponse(res, 404, "Cell group not found");

    return res.send({ error: false, data: cellGroup });
  }),

  // soft delete - flips isActive off and clears the cellGroup off every member's record
  deleteCellGroup: catchAsync(async (req, res) => {
    const cellGroup = await CellGroup.findOneAndUpdate(
      { _id: req.params.cellGroupId, church: req.params.churchId },
      { isActive: false },
      { new: true }
    );

    if (!cellGroup) return errorResponse(res, 404, "Cell group not found");

    await Membership.updateMany(
      { church: req.params.churchId, cellGroup: cellGroup._id },
      { $unset: { cellGroup: "" } }
    );

    return res.send({ error: false, message: "Cell group deactivated" });
  }),

  // bulk move/assign members into this group, then recompute the stored count
  assignMembers: catchAsync(async (req, res) => {
    const { membershipIds } = req.body;

    if (!Array.isArray(membershipIds) || membershipIds.length === 0) {
      return errorResponse(res, 400, "membershipIds array is required");
    }

    const result = await Membership.updateMany(
      {
        _id: { $in: membershipIds },
        church: req.params.churchId,
      },
      { $set: { cellGroup: req.params.cellGroupId } }
    );

    const count = await Membership.countDocuments({
      church: req.params.churchId,
      cellGroup: req.params.cellGroupId,
      status: "active",
    });

    await CellGroup.findByIdAndUpdate(req.params.cellGroupId, { memberCount: count });

    return res.send({
      error: false,
      assigned: result.modifiedCount,
      totalInGroup: count,
    });
  }),
};