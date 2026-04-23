/**
 * utils/churchNotifications.js
 *
 * High-level notification functions for every Churza event.
 * Each function wraps sendPushNotification with the correct
 * payload, recipients and deep-link data for that event.
 *
 * USAGE — import the function you need in any controller:
 *
 *   const { notifyMembershipApproved } = require('../utils/churchNotifications');
 *   await notifyMembershipApproved({ membership, church });
 *
 * DATA FIELD (deep linking):
 *   The `data` object is received by Flutter in the
 *   OneSignal notification opened handler. Flutter reads
 *   data.screen and data.id to navigate to the right screen.
 *
 *   Screens: Home, Sermons, CellChat, Notifications,
 *            MemberDetail, Events, Announcements, Giving, Live
 */

const { sendPushNotification } = require('./notifications');
const User = require('../models/User');
const Membership = require('../models/Membership');

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Get all active member userIds for a church.
 * Used to broadcast to the whole congregation.
 */
const getChurchMemberIds = async (churchId) => {
    const memberships = await Membership.find({
        church: churchId,
        status: 'active',
    }).select('user').lean();
    return memberships.map((m) => m.user.toString());
};

/**
 * Get admin/pastor userIds for a church.
 * Used for admin-only notifications.
 */
const getChurchAdminIds = async (churchId) => {
    const memberships = await Membership.find({
        church: churchId,
        status: 'active',
        role: { $in: ['admin', 'pastor', 'super_admin'] },
    }).select('user').lean();
    return memberships.map((m) => m.user.toString());
};

// ─────────────────────────────────────────────────────────
// MEMBERSHIP
// ─────────────────────────────────────────────────────────

/**
 * Member's request to join was approved.
 * Notify: the member
 * Trigger: after approveMember()
 */
const notifyMembershipApproved = async ({ membership, church }) => {
    await sendPushNotification({
        userIds: [membership.user.toString()],
        title: 'Membership approved!',
        body: `Welcome to ${church.name}. Your membership has been approved.`,
        data: { screen: 'Home' },
    });
};

/**
 * New member has requested to join — notify admins.
 * Notify: all admins and pastors of the church
 * Trigger: after joinByCode()
 */
const notifyNewMemberRequest = async ({ churchId, memberName, membershipId }) => {
    const adminIds = await getChurchAdminIds(churchId);
    if (!adminIds.length) return;

    await sendPushNotification({
        userIds: adminIds,
        title: 'New membership request',
        body: `${memberName} wants to join your church.`,
        data: { screen: 'MemberDetail', id: membershipId },
    });
};

/**
 * Member was added to a cell group.
 * Notify: the member
 * Trigger: after adding member to group
 */
const notifyAddedToGroup = async ({ userId, groupName, groupId }) => {
    await sendPushNotification({
        userIds: [userId.toString()],
        title: 'Added to cell group',
        body: `You have been added to ${groupName}.`,
        data: { screen: 'CellChat', id: groupId },
    });
};

/**
 * Member was appointed as cell group leader.
 * Notify: the member
 * Trigger: after assignLeader()
 */
const notifyLeaderAppointed = async ({ userId, groupName, groupId }) => {
    await sendPushNotification({
        userIds: [userId.toString()],
        title: 'You are now a cell leader',
        body: `You have been appointed as leader of ${groupName}.`,
        data: { screen: 'CellChat', id: groupId },
    });
};

// ─────────────────────────────────────────────────────────
// GIVING
// ─────────────────────────────────────────────────────────

/**
 * Giving transaction confirmed.
 * Notify: the member who gave
 * Trigger: after payment_intent.succeeded webhook
 */
const notifyGivingConfirmed = async ({ userId, amount, currency, type, churchName }) => {
    const symbols = {
        GBP: '£', USD: '$', EUR: '€', NGN: '₦',
        GHS: '₵', KES: 'KSh', ZAR: 'R', CAD: 'CA$',
    };
    const symbol = symbols[currency?.toUpperCase()] ?? currency ?? '£';
    const formatted = (amount / 100).toFixed(2);
    const typeLabel = type
        ? type.charAt(0).toUpperCase() + type.slice(1)
        : 'Gift';

    await sendPushNotification({
        userIds: [userId.toString()],
        title: 'Giving confirmed',
        body: `Your ${typeLabel} of ${symbol}${formatted} to ${churchName} was received. God bless you.`,
        data: { screen: 'Giving' },
    });
};

/**
 * Large gift received — notify admins.
 * Fires when a gift is above a threshold (default £500).
 * Notify: admins/pastors
 * Trigger: after payment_intent.succeeded webhook
 */
const notifyLargeGiftReceived = async ({
    churchId,
    memberName,
    amount,
    currency,
    threshold = 50000, // pence — £500
}) => {
    if (amount < threshold) return;

    const symbols = { GBP: '£', USD: '$', EUR: '€', NGN: '₦', GHS: '₵' };
    const symbol = symbols[currency?.toUpperCase()] ?? '£';
    const formatted = (amount / 100).toFixed(2);
    const adminIds = await getChurchAdminIds(churchId);
    if (!adminIds.length) return;

    await sendPushNotification({
        userIds: adminIds,
        title: 'Large gift received',
        body: `${memberName} gave ${symbol}${formatted}. Praise God!`,
        data: { screen: 'Giving' },
    });
};

/**
 * Stripe account verified — online giving now live.
 * Notify: the pastor/admin who connected Stripe
 * Trigger: after account.updated webhook (charges_enabled = true)
 */
const notifyStripeVerified = async ({ userId, churchName }) => {
    await sendPushNotification({
        userIds: [userId.toString()],
        title: 'Online giving is live!',
        body: `${churchName} can now receive tithes and offerings online.`,
        data: { screen: 'Giving' },
    });
};

// ─────────────────────────────────────────────────────────
// ATTENDANCE
// ─────────────────────────────────────────────────────────

/**
 * Pastor opened check-in — notify all members.
 * Notify: all active church members
 * Trigger: after startSession()
 */
const notifyCheckInOpened = async ({ churchId, sessionTitle }) => {
    const memberIds = await getChurchMemberIds(churchId);
    if (!memberIds.length) return;

    await sendPushNotification({
        userIds: memberIds,
        title: `${sessionTitle} check-in is open`,
        body: 'Tap to mark your attendance for today\'s service.',
        data: { screen: 'Home' },
    });
};

// ─────────────────────────────────────────────────────────
// SERMONS
// ─────────────────────────────────────────────────────────

/**
 * New sermon uploaded.
 * Notify: all active church members
 * Trigger: after createSermon() with status = published
 */
const notifyNewSermon = async ({ churchId, title, speaker }) => {
    const memberIds = await getChurchMemberIds(churchId);
    if (!memberIds.length) return;

    const body = speaker
        ? `New message from ${speaker}: ${title}`
        : `New message: ${title}`;

    await sendPushNotification({
        userIds: memberIds,
        title: 'New sermon',
        body,
        data: { screen: 'Sermons' },
    });
};

// ─────────────────────────────────────────────────────────
// LIVE STREAMING
// ─────────────────────────────────────────────────────────

/**
 * Live stream started.
 * Notify: all active church members
 * Trigger: after startLive()
 */
const notifyLiveStarted = async ({ churchId, churchName, title }) => {
    const memberIds = await getChurchMemberIds(churchId);
    if (!memberIds.length) return;

    await sendPushNotification({
        userIds: memberIds,
        title: `${churchName} is LIVE now`,
        body: title || 'Sunday Service is streaming. Tap to watch.',
        data: { screen: 'Live' },
    });
};

// ─────────────────────────────────────────────────────────
// ANNOUNCEMENTS
// ─────────────────────────────────────────────────────────

/**
 * New announcement posted.
 * Notify: all members (or leaders only if audience = 'leaders')
 * Trigger: after createAnnouncement()
 */
const notifyNewAnnouncement = async ({
    churchId,
    title,
    body,
    audience = 'all',
}) => {
    let userIds;

    if (audience === 'leaders') {
        const leaderships = await Membership.find({
            church: churchId,
            status: 'active',
            role: { $in: ['admin', 'pastor', 'cell_leader', 'deacon', 'worker'] },
        }).select('user').lean();
        userIds = leaderships.map((m) => m.user.toString());
    } else {
        userIds = await getChurchMemberIds(churchId);
    }

    if (!userIds.length) return;

    await sendPushNotification({
        userIds,
        title: `New announcement: ${title}`,
        body: body.length > 80 ? body.substring(0, 77) + '...' : body,
        data: { screen: 'Announcements' },
    });
};

// ─────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────

/**
 * New event created.
 * Notify: all active church members
 * Trigger: after createEvent()
 */
const notifyNewEvent = async ({ churchId, title, startsAt, eventId }) => {
    const memberIds = await getChurchMemberIds(churchId);
    if (!memberIds.length) return;

    const date = startsAt
        ? new Date(startsAt).toLocaleDateString('en-GB', {
            weekday: 'long', day: 'numeric', month: 'long',
        })
        : '';

    await sendPushNotification({
        userIds: memberIds,
        title: `New event: ${title}`,
        body: date ? `${date}. Tap to RSVP.` : 'Tap to view details and RSVP.',
        data: { screen: 'Events', id: eventId },
    });
};

/**
 * Event reminder — 24 hours before the event.
 * Notify: members who RSVPed
 * Trigger: scheduled cron job (run daily)
 */
const notifyEventReminder = async ({ event }) => {
    if (!event.rsvpList || event.rsvpList.length === 0) return;

    const userIds = event.rsvpList.map((id) => id.toString());

    await sendPushNotification({
        userIds,
        title: `Reminder: ${event.title}`,
        body: `Your event is tomorrow. See you there!`,
        data: { screen: 'Events', id: event._id.toString() },
    });
};

// ─────────────────────────────────────────────────────────
// PRAYER
// ─────────────────────────────────────────────────────────

/**
 * Someone prayed for a prayer request.
 * Notify: the member who posted the request
 * Only fire when prayer count hits 1, 5, 10, 25, 50
 * (avoid notifying on every single prayer)
 * Trigger: after prayForRequest()
 */
const notifyPrayerReceived = async ({ request, prayerCount }) => {
    const milestones = [1, 5, 10, 25, 50, 100];
    if (!milestones.includes(prayerCount)) return;
    if (request.isAnonymous) return; // don't reveal who prayed

    const userId = request.user?.toString?.() ?? request.user;

    const messages = {
        1: 'Someone is praying for you.',
        5: '5 people are praying for you.',
        10: '10 people are praying for you. You are not alone.',
        25: '25 members have prayed for your request.',
        50: '50 members have prayed. God hears every prayer.',
        100: '100 members have prayed for you!',
    };

    await sendPushNotification({
        userIds: [userId],
        title: 'People are praying for you',
        body: messages[prayerCount] ?? `${prayerCount} people are praying for you.`,
        data: { screen: 'Notifications' },
    });
};

// ─────────────────────────────────────────────────────────
// CRON JOBS (scheduled triggers)
// ─────────────────────────────────────────────────────────

/**
 * eventReminderCron — runs daily at 9am.
 * Finds events starting in the next 24 hours and
 * notifies members who RSVPed.
 *
 * Add to your cron setup:
 *   cron.schedule('0 9 * * *', eventReminderCron);
 */
const eventReminderCron = async () => {
    try {
        const Event = require('../models/Event');

        const now = new Date();
        const in24hrs = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const in25hrs = new Date(now.getTime() + 25 * 60 * 60 * 1000);

        const upcomingEvents = await Event.find({
            status: 'upcoming',
            startsAt: { $gte: in24hrs, $lt: in25hrs },
            rsvpList: { $exists: true, $not: { $size: 0 } },
        }).lean();

        for (const event of upcomingEvents) {
            await notifyEventReminder({ event });
            console.log(`Event reminder sent for: ${event.title}`);
        }
    } catch (err) {
        console.error('Event reminder cron error:', err.message);
    }
};

/**
 * giftAidReminderCron — runs once a year on 1st April.
 * Reminds UK church members to enable Gift Aid on their giving.
 *
 * Add to your cron setup:
 *   cron.schedule('0 9 1 4 *', giftAidReminderCron);
 */
const giftAidReminderCron = async () => {
    try {
        const Church = require('../models/Church');

        // Find UK churches (currency GBP)
        const ukChurches = await Church.find({
            'settings.currency': 'GBP',
            isActive: true,
        }).lean();

        for (const church of ukChurches) {
            const memberIds = await getChurchMemberIds(church._id);
            if (!memberIds.length) continue;

            // await sendPushNotification({
            //     userIds: memberIds,
            //     title: 'Gift Aid reminder',
            //     body: `Enable Gift Aid on your giving — ${church.name} can claim 25% back from HMRC at no cost to you.`,
            //     data: { screen: 'Giving' },
            // });
        }
    } catch (err) {
        console.error('Gift Aid cron error:', err.message);
    }
};

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

module.exports = {
    // Membership
    notifyMembershipApproved,
    notifyNewMemberRequest,
    notifyAddedToGroup,
    notifyLeaderAppointed,

    // Giving
    notifyGivingConfirmed,
    notifyLargeGiftReceived,
    notifyStripeVerified,

    // Attendance
    notifyCheckInOpened,

    // Sermons
    notifyNewSermon,

    // Live
    notifyLiveStarted,

    // Announcements
    notifyNewAnnouncement,

    // Events
    notifyNewEvent,
    notifyEventReminder,

    // Prayer
    notifyPrayerReceived,

    // Crons
    eventReminderCron,
    giftAidReminderCron,
};