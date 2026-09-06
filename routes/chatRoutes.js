const controller = require("../controllers/chatController");
const { rootUrl } = require("../utils/constants");
const { protect, requireChurchRole, requireActiveMembership } = require("../middleware/auth");
const upload = require("../middleware/upload");

module.exports = (app) => {
    app.post(rootUrl("/churches/:churchId/groups"), protect, requireChurchRole("admin", "pastor"), controller.createCellGroup);
    app.get(rootUrl("/churches/:churchId/groups"), protect, requireActiveMembership, controller.getCellGroups);
    app.get(rootUrl("/churches/:churchId/groups/:groupId"), protect, requireActiveMembership, controller.getCellGroup);
    app.patch(rootUrl("/churches/:churchId/groups/:groupId"), protect, requireChurchRole("admin", "pastor"), controller.updateCellGroup);
    app.patch(rootUrl("/churches/:churchId/groups/:groupId/members"), protect, requireChurchRole("admin", "pastor"), controller.updateGroupMembers);
    app.get(rootUrl("/churches/:churchId/groups/:groupId/messages"), protect, requireActiveMembership, controller.getMessages);
    app.post(rootUrl("/churches/:churchId/groups/:groupId/upload"), protect, requireActiveMembership, upload.single("file"), controller.uploadFile);
    app.delete(rootUrl("/churches/:churchId/groups/:groupId/messages/:messageId"), protect, requireActiveMembership, controller.deleteMessage);
    app.patch(rootUrl("/churches/:churchId/groups/:groupId/leader"), protect, requireChurchRole("admin", "pastor"), controller.assignLeader);
};