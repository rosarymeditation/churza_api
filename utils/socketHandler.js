/**
 * socketServer.js — The real-time chat engine
 *
 * HOW SOCKET.IO WORKS (plain English):
 *
 * Normal HTTP (what your REST API uses):
 *   Client: "Hey server, give me the messages"
 *   Server: "Here are the messages"
 *   Connection closes.
 *   Client has to ask again to get new messages.
 *
 * Socket.IO (what chat uses):
 *   Client: "Hey server, I'm connected"
 *   Connection stays open permanently.
 *   Server can push data to client ANY TIME without being asked.
 *   Client can send data to server ANY TIME.
 *
 * This is how WhatsApp works — you are always connected.
 * When someone sends you a message, WhatsApp's server
 * pushes it to your phone instantly without you asking.
 *
 * ROOMS (how we separate group chats):
 *   Each cell group has its own "room".
 *   When you open the North London Cell chat,
 *   your socket joins room "cell_<cellGroupId>".
 *   Messages sent to that room only reach members
 *   who have joined that room.
 *   This is exactly how WhatsApp groups work.
 *
 * EVENTS (how sockets communicate):
 *   Think of events like channels on a radio.
 *   Client tunes into "message:new" to receive new messages.
 *   Client broadcasts on "message:send" to send a message.
 *   Server listens and redistributes.
 */

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const CellGroup = require('../models/CellGroup');
const ChatMessage = require('../models/ChatMessage');
const cloudinary = require('../config/cloudinary');
const { sendPushNotification } = require('../utils/notifications');

/**
 * initSocket — Attaches Socket.IO to your existing Express HTTP server.
 *
 * Call this in server.js:
 *   const { initSocket } = require('./socketServer');
 *   const httpServer = app.listen(PORT, ...);
 *   initSocket(httpServer);
 *
 * @param {http.Server} httpServer - Your Express HTTP server instance
 */
const initSocket = (httpServer) => {
    

    // Create the Socket.IO server attached to your HTTP server
    // cors: allows your Flutter app to connect from any origin
    const io = new Server(httpServer, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
        // pingTimeout: how long to wait before declaring a connection dead
        // pingInterval: how often to send a heartbeat to keep connection alive
        pingTimeout: 60000,
        pingInterval: 25000,
    });

    // ── AUTHENTICATION MIDDLEWARE ──────────────────────────
    // Before any socket connection is accepted, we verify the JWT.
    // This runs ONCE when the socket first connects.
    // If the token is invalid, the connection is rejected.
    //
    // The Flutter app sends the token in the auth object:
    //   socket = io(url, { auth: { token: 'Bearer eyJ...' } });
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token?.replace('Bearer ', '');
            if (!token) return next(new Error('Authentication required'));

            // Verify the JWT — same secret as your REST API
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Fetch the user from DB and attach to socket
            // socket.user is now available in all event handlers below
            const user = await User.findById(decoded.id).select(
                'firstName lastName photoUrl'
            );
            if (!user) return next(new Error('User not found'));

            socket.user = user;
            next(); // ✅ Connection accepted
        } catch (err) {
            next(new Error('Invalid token'));
        }
    });

    // ── CONNECTION HANDLER ────────────────────────────────
    // This runs every time a new socket connects successfully.
    // socket = the individual connection for ONE user on ONE device.
    io.on('connection', (socket) => {
        console.log(`🔌 Socket connected: ${socket.user.firstName} ${socket.user.lastName} [${socket.id}]`);

        // ── EVENT: join:cell ───────────────────────────────
        // Flutter calls this when user opens a cell group chat.
        // We put the socket into a room so it receives messages
        // sent to that specific group.
        //
        // Flutter sends: { cellGroupId: '64abc...' }
        socket.on('join:cell', async ({ cellGroupId }) => {
            try {
                // Security check — verify this user is actually a member
                const group = await CellGroup.findById(cellGroupId);
                if (!group) return;

                const isMember = group.members.some(
                    (m) => m.toString() === socket.user._id.toString()
                );
                const isLeader = group.leader?.toString() === socket.user._id.toString();

                if (!isMember && !isLeader) {
                    socket.emit('error', { message: 'Not a member of this group' });
                    return;
                }

                // Join the room — room name is "cell_<cellGroupId>"
                const room = `cell_${cellGroupId}`;
                socket.join(room);

                // Tell the client they successfully joined
                socket.emit('joined:cell', { cellGroupId, room });

                // Mark all unread messages as read when user joins
                await ChatMessage.updateMany(
                    {
                        cellGroup: cellGroupId,
                        readBy: { $ne: socket.user._id }, // not already read by this user
                        isDeleted: false,
                    },
                    { $addToSet: { readBy: socket.user._id } }
                );

                console.log(`👥 ${socket.user.firstName} joined room: ${room}`);
            } catch (err) {
                console.error('join:cell error:', err.message);
            }
        });

        // ── EVENT: leave:cell ──────────────────────────────
        // Flutter calls this when user closes the chat screen.
        // We remove them from the room so they stop receiving
        // real-time messages (they will still get push notifications).
        socket.on('leave:cell', ({ cellGroupId }) => {
            const room = `cell_${cellGroupId}`;
            socket.leave(room);
            console.log(`👋 ${socket.user.firstName} left room: ${room}`);
        });

        // ── EVENT: message:send ────────────────────────────
        // Flutter calls this when user sends a TEXT message.
        // For files/voice, use the REST API upload endpoint instead
        // (because files need multipart upload, not sockets).
        //
        // Flutter sends:
        // {
        //   cellGroupId: '64abc...',
        //   body: 'Good morning everyone 🙏',
        //   replyTo: { messageId, senderName, preview } // optional
        // }
        socket.on('message:send', async (data) => {
            try {
                console.log(data)
                const { cellGroupId, body, replyTo } = data;

                if (!body || !body.trim()) return;

                // Security — verify membership again
                const group = await CellGroup.findById(cellGroupId)
                    .populate('members', '_id');
                if (!group) return;

                const isMember = group.members.some(
                    (m) => m._id.toString() === socket.user._id.toString()
                );
                console.log("ooooooooooo")
                console.log(isMember)
                console.log(socket.user);
                const isLeader = group.leader?.toString() === socket.user._id.toString();
                if (!isMember && !isLeader) return;
                console.log(cellGroupId)
                // Save the message to MongoDB
                const message = await ChatMessage.create({
                    cellGroup: cellGroupId,
                    church: group.church,
                    sender: socket.user._id,
                    type: 'text',
                    body: body.trim(),
                    replyTo: replyTo || undefined,
                    readBy: [socket.user._id], // sender has "read" their own message
                });

                // Populate sender info for the response
                await message.populate('sender', 'firstName lastName photoUrl');

                // Build the payload to send to all room members
                const payload = {
                    _id: message._id,
                    cellGroup: cellGroupId,
                    sender: {
                        _id: socket.user._id,
                        firstName: socket.user.firstName,
                        lastName: socket.user.lastName,
                        photoUrl: socket.user.photoUrl,
                    },
                    type: 'text',
                    body: message.body,
                    replyTo: message.replyTo || null,
                    readBy: [socket.user._id],
                    createdAt: message.createdAt,
                };

                // Broadcast to everyone in the room EXCEPT the sender
                // The sender's UI already shows the message (optimistic update)
                const room = `cell_${cellGroupId}`;
                socket.to(room).emit('message:new', payload);

                // Confirm to the sender that message was saved
                // This lets Flutter replace the "sending..." state with the real message
                socket.emit('message:sent', {
                    tempId: data.tempId, // Flutter sends a temp ID for optimistic UI
                    messageId: message._id,
                    createdAt: message.createdAt,
                });

                // ── Push notification ──────────────────────────
                // Members who are NOT in the room (app closed or on different screen)
                // need a push notification so they know a message arrived.
                //
                // We get all member IDs, exclude those currently in the room,
                // and send push notifications to the rest.
                const socketsInRoom = await io.in(room).fetchSockets();
                const onlineUserIds = socketsInRoom.map(
                    (s) => s.user._id.toString()
                );

                // Get all member IDs except sender and online members
                const offlineMembers = group.members
                    .filter((m) => {
                        const id = m._id.toString();
                        return (
                            id !== socket.user._id.toString() &&
                            !onlineUserIds.includes(id)
                        );
                    })
                    .map((m) => m._id.toString());

                if (offlineMembers.length > 0) {
                    const senderName =
                        `${socket.user.firstName} ${socket.user.lastName}`.trim();
                    await sendPushNotification({
                        userIds: offlineMembers,
                        title: `${group.name}`,
                        body: `${senderName}: ${body.trim().substring(0, 100)}`,
                        data: {
                            screen: 'CellChat',
                            cellGroupId: cellGroupId,
                        },
                    });
                }

            } catch (err) {
                console.error('message:send error:', err.message);
                socket.emit('error', { message: 'Failed to send message' });
            }
        });
        socket.on('message:file', async ({ cellGroupId, message }) => {
            try {
                if (!cellGroupId || !message) return;

                // Security — verify this user is a member of the group
                const group = await CellGroup.findById(cellGroupId)
                    .populate('members', '_id');
                if (!group) return;

                const isMember = group.members.some(
                    (m) => m._id.toString() === socket.user._id.toString()
                );
                const isLeader = group.leader?.toString() === socket.user._id.toString();
                if (!isMember && !isLeader) return;

                // Broadcast the message to everyone in the room
                // INCLUDING the sender — so all other devices of the sender
                // also receive it (important if someone is logged in on two devices)
                const room = `cell_${cellGroupId}`;
                socket.to(room).emit('message:new', message);

                console.log(
                    `📎 ${socket.user.firstName} sent a ${message.type} to ${group.name}`
                );
            } catch (err) {
                console.error('message:file error:', err.message);
            }
        });
        // ── EVENT: message:delete ──────────────────────────
        // User long-presses a message and taps Delete.
        // Only the sender, cell leader, or admin can delete.
        //
        // Flutter sends: { messageId, cellGroupId }
        socket.on('message:delete', async ({ messageId, cellGroupId }) => {
            try {
                const message = await ChatMessage.findById(messageId);
                if (!message) return;

                const group = await CellGroup.findById(cellGroupId);
                const isSender = message.sender.toString() === socket.user._id.toString();
                const isLeader = group?.leader?.toString() === socket.user._id.toString();

                if (!isSender && !isLeader) {
                    socket.emit('error', { message: 'Cannot delete this message' });
                    return;
                }

                // Soft delete — we mark it deleted but keep the record
                // This way the UI can show "This message was deleted"
                // rather than leaving a gap in the conversation
                message.isDeleted = true;
                message.deletedAt = new Date();
                message.deletedBy = socket.user._id;
                await message.save();

                // Tell everyone in the room this message was deleted
                const room = `cell_${cellGroupId}`;
                io.to(room).emit('message:deleted', { messageId });

            } catch (err) {
                console.error('message:delete error:', err.message);
            }
        });

        // ── EVENT: typing:start ────────────────────────────
        // When user starts typing, show "James is typing..." to others.
        // Flutter sends this when the text field gets focus or text changes.
        //
        // Flutter sends: { cellGroupId }
        socket.on('typing:start', ({ cellGroupId }) => {
            const room = `cell_${cellGroupId}`;
            socket.to(room).emit('typing:start', {
                userId: socket.user._id,
                userName: `${socket.user.firstName}`,
            });
        });

        // ── EVENT: typing:stop ─────────────────────────────
        // When user stops typing. Flutter sends this after a 2 second
        // pause in typing or when the message is sent.
        socket.on('typing:stop', ({ cellGroupId }) => {
            const room = `cell_${cellGroupId}`;
            socket.to(room).emit('typing:stop', {
                userId: socket.user._id,
            });
        });

        // ── EVENT: message:read ────────────────────────────
        // When a member opens the chat and sees messages,
        // Flutter sends this to mark them as read.
        //
        // Flutter sends: { cellGroupId, messageIds: ['id1', 'id2'] }
        socket.on('message:read', async ({ cellGroupId, messageIds }) => {
            try {
                // Mark all specified messages as read by this user
                await ChatMessage.updateMany(
                    {
                        _id: { $in: messageIds },
                        cellGroup: cellGroupId,
                    },
                    { $addToSet: { readBy: socket.user._id } }
                );

                // Tell the room (specifically the senders) that messages were read
                const room = `cell_${cellGroupId}`;
                socket.to(room).emit('message:read', {
                    messageIds,
                    readBy: socket.user._id,
                });
            } catch (err) {
                console.error('message:read error:', err.message);
            }
        });

        // ── DISCONNECT ─────────────────────────────────────
        // Runs when a user's connection drops — they closed the app,
        // lost internet, or switched to background.
        // Socket.IO handles reconnection automatically — the client
        // will reconnect and re-join rooms when internet comes back.
        socket.on('disconnect', (reason) => {
            console.log(
                `🔌 Socket disconnected: ${socket.user.firstName} — ${reason}`
            );
        });
    });

    console.log('✅ Socket.IO server initialised');
    return io;
};

module.exports = { initSocket };