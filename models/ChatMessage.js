const mongoose = require('mongoose');

/**
 * ChatMessage — A single message in a cell group chat.
 *
 * Every message sent by any member is stored here.
 * Messages belong to a cell group (like a WhatsApp group).
 *
 * Message types:
 * - text     : Plain text message ("Good morning everyone 🙏")
 * - voice    : Audio recording (stored on Cloudinary)
 * - file     : Document like PDF or image (stored on Cloudinary)
 * - system   : Automated messages ("James joined the group")
 *
 * Read receipts:
 * We store an array of user IDs who have read the message.
 * This lets us show "Read by 12 members" like WhatsApp.
 */
const chatMessageSchema = new mongoose.Schema(
    {
        // Which cell group this message belongs to
        // Like a WhatsApp group — messages belong to the group
        cellGroup: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CellGroup',
            required: true,
            index: true,
        },

        // Which church (for security — we always verify church membership)
        church: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Church',
            required: true,
        },

        // Who sent this message
        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },

        // ── Message content ──────────────────────────────────

        // The type of message
        // text  → body field contains the text
        // voice → fileUrl contains the Cloudinary audio URL
        // file  → fileUrl contains the Cloudinary file URL
        // system → body contains the system message text
        type: {
            type: String,
            enum: ['text', 'voice', 'file', 'system'],
            default: 'text',
        },

        // Text content (for text and system messages)
        body: {
            type: String,
            trim: true,
            maxlength: 4000,
        },

        // File/voice details (for voice and file messages)
        fileUrl: { type: String },  // Cloudinary secure URL
        fileName: { type: String },  // Original file name e.g. "prayer_notes.pdf"
        fileSize: { type: Number },  // Size in bytes
        fileMimeType: { type: String },  // e.g. "audio/m4a", "application/pdf"
        fileDuration: { type: Number },  // For voice: duration in seconds

        // ── Reply threading ──────────────────────────────────
        // If this message is a reply to another message
        // We store just enough info to show the quoted message
        // without fetching the full message from the DB
        replyTo: {
            messageId: { type: mongoose.Schema.Types.ObjectId },
            senderName: { type: String },  // "Brother James"
            preview: { type: String },  // First 100 chars of original message
            type: { type: String },  // Type of the original message
        },

        // ── Read receipts ────────────────────────────────────
        // Array of user IDs who have seen this message
        // When a member opens the chat, we add their ID here
        readBy: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        }],

        // ── Moderation ───────────────────────────────────────
        // Admins and leaders can delete messages
        isDeleted: { type: Boolean, default: false },
        deletedAt: { type: Date },
        deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    {
        timestamps: true,  // Adds createdAt and updatedAt automatically
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// ── Indexes for performance ───────────────────────────────
// When a member opens the chat, we fetch the last 50 messages
// for a specific cell group, sorted by newest first.
// This index makes that query very fast.
chatMessageSchema.index({ cellGroup: 1, createdAt: -1 });

// For unread count queries — "how many messages in this group
// were sent after this user last opened the chat?"
chatMessageSchema.index({ cellGroup: 1, createdAt: 1, readBy: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);