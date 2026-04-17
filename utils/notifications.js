/**
 * utils/notifications.js — OneSignal push notification helper
 *
 * HOW ONESIGNAL WORKS:
 *
 * 1. When a member installs the app, OneSignal generates
 *    a unique "player ID" (also called external_id) for their device.
 *
 * 2. Flutter saves this player ID to your backend (User model).
 *
 * 3. When you want to notify someone, you send the player ID
 *    to OneSignal's API with a message.
 *
 * 4. OneSignal delivers it to their device via
 *    Apple Push Notification Service (iOS) or
 *    Firebase Cloud Messaging (Android).
 *
 * You never deal with Apple or Google directly.
 * OneSignal handles all of that complexity.
 *
 * SETUP REQUIRED:
 * - Create a OneSignal account at onesignal.com
 * - Create an app for Churza
 * - Add your iOS and Android credentials to OneSignal
 * - Get your App ID and REST API key
 * - Add to .env:
 *     ONESIGNAL_APP_ID=your-app-id
 *     ONESIGNAL_API_KEY=your-rest-api-key
 */

const https = require('https');
const User = require('../models/User');

/**
 * sendPushNotification — Send a push notification to specific users.
 *
 * @param {Object} options
 * @param {string[]} options.userIds   - Array of MongoDB User _id strings
 * @param {string}   options.title     - Notification title (bold text)
 * @param {string}   options.body      - Notification body text
 * @param {Object}   options.data      - Extra data sent to Flutter
 *                                       e.g. { screen: 'CellChat', cellGroupId: '...' }
 *
 * Example usage:
 *   await sendPushNotification({
 *     userIds: ['64abc...', '64def...'],
 *     title:   'North London Cell',
 *     body:    'Brother James: Good morning everyone 🙏',
 *     data:    { screen: 'CellChat', cellGroupId: '64abc...' },
 *   });
 */
const sendPushNotification = async ({ userIds, title, body, data = {} }) => {
  try {
    if (!userIds || userIds.length === 0) return;

    // Fetch OneSignal player IDs for these users
    // Users who have not granted notification permission will have no pushToken
    const users = await User.find(
      { _id: { $in: userIds }, pushToken: { $exists: true, $ne: null } },
      'pushToken'
    ).lean();

    const playerIds = users
      .map((u) => u.pushToken)
      .filter(Boolean);

    if (playerIds.length === 0) return;

    // Build the OneSignal notification payload
    const notification = {
      app_id: process.env.ONESIGNAL_APP_ID,
      include_player_ids: playerIds,       // Which devices to notify
      headings: { en: title },            // Bold title
      contents: { en: body },             // Message body
      data,                                // Extra data Flutter reads on tap
      ios_badgeType: 'Increase',         // Increment the badge count on iOS
      ios_badgeCount: 1,
      android_group: data.screen || 'churza', // Group notifications on Android
      priority: 10,                 // High priority — deliver immediately
    };

    // Send to OneSignal REST API
    const jsonPayload = JSON.stringify(notification);

    const options = {
      hostname: 'onesignal.com',
      port: 443,
      path: '/api/v1/notifications',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,
        'Content-Length': Buffer.byteLength(jsonPayload),
      },
    };

    // Make the HTTPS request to OneSignal
    await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => (responseData += chunk));
        res.on('end', () => {
          const parsed = JSON.parse(responseData);
          if (parsed.errors) {
            console.warn('OneSignal warning:', parsed.errors);
          }
          resolve(parsed);
        });
      });
      req.on('error', reject);
      req.write(jsonPayload);
      req.end();
    });

  } catch (err) {
    // Non-critical — if push fails, the message is still delivered via socket
    // We log the error but do not throw, so chat still works
    console.error('Push notification failed:', err.message);
  }
};

/**
 * savePushToken — Save a user's OneSignal player ID to MongoDB.
 *
 * Call this from your user routes when Flutter sends the token.
 * Flutter sends the token after the user grants notification permission.
 *
 * @param {string} userId    - MongoDB User _id
 * @param {string} pushToken - OneSignal player ID from Flutter
 */
const savePushToken = async (userId, pushToken) => {
  try {
    await User.findByIdAndUpdate(userId, { pushToken });
  } catch (err) {
    console.error('Save push token failed:', err.message);
  }
};

module.exports = { sendPushNotification, savePushToken };