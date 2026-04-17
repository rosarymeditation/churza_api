const CellGroup = require('../models/CellGroup');
const Membership = require('../models/Membership');

const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const errorResponse = (res, statusCode, message) =>
  res.status(statusCode).json({ success: false, message });

/**
 * POST /api/churches/:churchId/cell-groups
 *
 * Create a new cell group.
 *
 * Body: { name, description, leader, assistantLeader,
 *         meetingDay, meetingTime, meetingLocation, zone }
 * Auth: admin | pastor
 */
const createCellGroup = catchAsync(async (req, res) => {
  if (!req.body.name) return errorResponse(res, 400, 'Cell group name is required');

  const cellGroup = await CellGroup.create({
    church: req.params.churchId,
    ...req.body,
  });

  // If a leader is assigned, update their membership role
  if (req.body.leader) {
    await Membership.findByIdAndUpdate(req.body.leader, {
      role: 'cell_leader',
      cellGroup: cellGroup._id,
    });
  }

  res.status(201).json({ success: true, cellGroup });
});

/**
 * GET /api/churches/:churchId/cell-groups
 *
 * Returns all active cell groups for a church.
 *
 * Query: ?zone=Lagos+South
 * Auth: active member
 */
const getCellGroups = catchAsync(async (req, res) => {
  const filter = { church: req.params.churchId, isActive: true };
  if (req.query.zone) filter.zone = new RegExp(req.query.zone, 'i');

  const cellGroups = await CellGroup.find(filter)
    .populate({
      path: 'leader',
      populate: { path: 'user', select: 'firstName lastName photoUrl' },
    })
    .sort({ name: 1 })
    .lean();

  res.status(200).json({ success: true, total: cellGroups.length, cellGroups });
});

/**
 * GET /api/churches/:churchId/cell-groups/:cellGroupId
 *
 * Returns a single cell group with its members.
 *
 * Auth: active member
 */
const getCellGroup = catchAsync(async (req, res) => {
  const cellGroup = await CellGroup.findOne({
    _id: req.params.cellGroupId,
    church: req.params.churchId,
  })
    .populate({
      path: 'leader',
      populate: { path: 'user', select: 'firstName lastName photoUrl phone' },
    });

  if (!cellGroup) return errorResponse(res, 404, 'Cell group not found');

  const members = await Membership.find({
    church: req.params.churchId,
    cellGroup: cellGroup._id,
    status: 'active',
  })
    .populate('user', 'firstName lastName photoUrl phone')
    .lean();

  res.status(200).json({ success: true, cellGroup, members });
});

/**
 * PATCH /api/churches/:churchId/cell-groups/:cellGroupId
 *
 * Update a cell group.
 *
 * Auth: admin | pastor
 */
const updateCellGroup = catchAsync(async (req, res) => {
  const cellGroup = await CellGroup.findOneAndUpdate(
    { _id: req.params.cellGroupId, church: req.params.churchId },
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!cellGroup) return errorResponse(res, 404, 'Cell group not found');

  res.status(200).json({ success: true, cellGroup });
});

/**
 * DELETE /api/churches/:churchId/cell-groups/:cellGroupId
 *
 * Deactivates a cell group and unlinks all its members.
 *
 * Auth: admin | pastor
 */
const deleteCellGroup = catchAsync(async (req, res) => {
  const cellGroup = await CellGroup.findOneAndUpdate(
    { _id: req.params.cellGroupId, church: req.params.churchId },
    { isActive: false },
    { new: true }
  );

  if (!cellGroup) return errorResponse(res, 404, 'Cell group not found');

  // Unlink all members from this cell group
  await Membership.updateMany(
    { church: req.params.churchId, cellGroup: cellGroup._id },
    { $unset: { cellGroup: '' } }
  );

  res.status(200).json({ success: true, message: 'Cell group deactivated' });
});

/**
 * PATCH /api/churches/:churchId/cell-groups/:cellGroupId/assign
 *
 * Assign or move members to this cell group.
 *
 * Body: { membershipIds: ['id1', 'id2'] }
 * Auth: admin | pastor
 */
const assignMembers = catchAsync(async (req, res) => {
  const { membershipIds } = req.body;

  if (!Array.isArray(membershipIds) || membershipIds.length === 0) {
    return errorResponse(res, 400, 'membershipIds array is required');
  }

  const result = await Membership.updateMany(
    {
      _id: { $in: membershipIds },
      church: req.params.churchId,
    },
    { $set: { cellGroup: req.params.cellGroupId } }
  );

  // Recalculate member count
  const count = await Membership.countDocuments({
    church: req.params.churchId,
    cellGroup: req.params.cellGroupId,
    status: 'active',
  });

  await CellGroup.findByIdAndUpdate(req.params.cellGroupId, { memberCount: count });

  res.status(200).json({
    success: true,
    assigned: result.modifiedCount,
    totalInGroup: count,
  });
});

module.exports = {
  createCellGroup,
  getCellGroups,
  getCellGroup,
  updateCellGroup,
  deleteCellGroup,
  assignMembers,
};
