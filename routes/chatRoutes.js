const express = require('express');
const router = express.Router();
const { protect, requireChurchRole, requireActiveMembership } = require('../middleware/auth');
const upload = require('../middleware/upload');
const c = require('../controllers/chatController');

router.post('/churches/:churchId/groups', protect, requireChurchRole('admin', 'pastor'), c.createCellGroup);
router.get('/churches/:churchId/groups', protect, requireActiveMembership, c.getCellGroups);
router.get('/churches/:churchId/groups/:groupId', protect, requireActiveMembership, c.getCellGroup);
router.patch('/churches/:churchId/groups/:groupId', protect, requireChurchRole('admin', 'pastor'), c.updateCellGroup);
router.patch('/churches/:churchId/groups/:groupId/members', protect, requireChurchRole('admin', 'pastor'), c.updateGroupMembers);
router.get('/churches/:churchId/groups/:groupId/messages', protect, requireActiveMembership, c.getMessages);
router.post('/churches/:churchId/groups/:groupId/upload', protect, requireActiveMembership, upload.single('file'), c.uploadFile);
router.delete('/churches/:churchId/groups/:groupId/messages/:messageId', protect, requireActiveMembership, c.deleteMessage);
router.patch(
    '/churches/:churchId/groups/:groupId/leader',
    protect,
    requireChurchRole('admin', 'pastor'),
    c.assignLeader
);
module.exports = router;