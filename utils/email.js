const nodemailer = require('nodemailer');

/**
 * utils/email.js
 *
 * Churza transactional email utility.
 * Follows same pattern as your existing Foodengo/LetsMunch setup.
 *
 * Add to .env:
 *   SMTP_USER=noreply@churza.app
 *   SMTP_PASS=your-hostinger-email-password
 *   EMAIL_FROM=noreply@churza.app
 */

// ── Transporter ────────────────────────────────────────────
// Hostinger SMTP — same approach as your Foodengo setup
const _transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true, // SSL on port 465
    tls: {
        rejectUnauthorized: false,
    },
    auth: {
        user: process.env.SMTP_USER, // e.g. noreply@churza.app
        pass: process.env.SMTP_PASS, // your Hostinger mailbox password
    },
});

// ── Branded HTML wrapper ───────────────────────────────────
// Wraps all emails in the Churza navy + gold design
const _wrap = (body, churchName = 'Churza') => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#0B1F3A;padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#C9A84C;font-size:28px;font-weight:700;letter-spacing:3px;">CHURZA</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.5);font-size:12px;">Church Management Platform</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f8f8;padding:24px 40px;text-align:center;border-top:1px solid #eeeeee;">
              <p style="margin:0;font-size:12px;color:#999999;line-height:1.6;">
                This email was sent by <strong style="color:#C9A84C;">${churchName}</strong> via Churza.<br>
                © ${new Date().getFullYear()} Churza by Softnergy Limited. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// ── Core send function ─────────────────────────────────────
/**
 * send — Send an email. Same signature as your Foodengo send().
 *
 * @param {Object} option — nodemailer mail options
 * @returns Promise
 *
 * @example
 * send(welcomeOptions('james@email.com', 'James', 'Grace Chapel', 'Churza123'));
 */
const send = (option) => {
    return _transporter.sendMail(option, (error, info) => {
        if (error) {
            console.error('📧 Email error:', error.message);
            return null;
        }
        console.log(`📧 Email sent to ${option.to} — ${option.subject}`);
        return info;
    });
};

/**
 * sendEmail — Promise-based version for async/await usage.
 * Use this in controllers where you need to await the result.
 */
const sendEmail = ({ to, subject, html, churchName }) => {
    return _transporter.sendMail({
        from: `"${churchName || 'Churza'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
        to,
        subject,
        html: _wrap(html, churchName),
    });
};

// ─────────────────────────────────────────────────────────
// Email option builders
// Same pattern as your options(), inviteOptions() etc.
// ─────────────────────────────────────────────────────────

/**
 * welcomeOptions — Admin creates a member account.
 * Member receives their temporary password.
 */
const welcomeOptions = (recipient, firstName, churchName, tempPassword) => ({
    from: `"${churchName}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: recipient,
    subject: `Welcome to ${churchName} — Your Churza account is ready`,
    html: _wrap(`
    <h2 style="color:#0B1F3A;font-size:22px;margin:0 0 16px;">Welcome to ${churchName}! 🙏</h2>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Hello <strong>${firstName}</strong>,
    </p>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Your pastor has created a Churza account so you can stay connected 
      with <strong>${churchName}</strong> — access sermons, giving, 
      announcements, events and your cell group chat.
    </p>

    <p style="color:#444;font-size:15px;margin:0 0 8px;"><strong>Your login details:</strong></p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;border:1px solid #E8E0CC;border-radius:8px;margin:0 0 20px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:14px;color:#444;">
            <strong style="color:#0B1F3A;">Email:</strong> ${recipient}
          </p>
          <p style="margin:0 0 4px;font-size:14px;color:#444;">
            <strong style="color:#0B1F3A;">Temporary password:</strong>
          </p>
          <p style="margin:0;font-size:22px;font-weight:700;color:#C9A84C;letter-spacing:2px;font-family:monospace;">
            ${tempPassword}
          </p>
        </td>
      </tr>
    </table>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Download the Churza app, sign in with these details, and you will be 
      asked to set a new password on your first login.
    </p>

    <hr style="border:none;border-top:1px solid #eeeeee;margin:24px 0;">

    <p style="color:#999;font-size:12px;margin:0;">
      If you did not expect this email please contact your church admin.
      Never share your password with anyone.
    </p>
  `, churchName),
});

const stripeConnectedOptions = (recipient, firstName, churchName) => ({
  from: `"Churza" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
  to: recipient,
  subject: 'Online giving is now live on Churza',
  html: _wrap(`
    <h2>Online giving is active! 🎉</h2>
    <p>Hello ${firstName},</p>
    <p>${churchName} can now receive online tithes and offerings through Churza.</p>

    <p><strong>Fee structure:</strong></p>
    <div class="credentials">
      <p>Churza platform fee: <strong>1.5%</strong></p>
      <p>Stripe processing fee: <strong>1.5% + 20p</strong></p>
      <p>Total deducted: <strong>~3% + 20p per transaction</strong></p>
    </div>

    <p><strong>Example:</strong> On a £100 gift, ${churchName} receives approximately <strong>£96.80</strong>.</p>

    <p>Funds are paid out to your bank account on a rolling basis by Stripe, 
    typically within 2–7 business days.</p>

    <p>You can view all transactions in the Churza admin panel under Giving.</p>
  `, churchName),
});

/**
 * membershipApprovedOptions — Sent when admin approves a pending member.
 */
const membershipApprovedOptions = (recipient, firstName, churchName, membershipNumber) => ({
    from: `"${churchName}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: recipient,
    subject: `You're now a member of ${churchName} 🎉`,
    html: _wrap(`
    <h2 style="color:#0B1F3A;font-size:22px;margin:0 0 16px;">Membership approved! 🎉</h2>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Hello <strong>${firstName}</strong>,
    </p>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Your membership request for <strong>${churchName}</strong> has been 
      approved. Welcome to the family!
    </p>

    ${membershipNumber ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;border:1px solid #E8E0CC;border-radius:8px;margin:0 0 20px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:14px;color:#0B1F3A;"><strong>Your membership number:</strong></p>
          <p style="margin:0;font-size:22px;font-weight:700;color:#C9A84C;letter-spacing:2px;font-family:monospace;">
            ${membershipNumber}
          </p>
        </td>
      </tr>
    </table>
    <p style="color:#999;font-size:12px;margin:0 0 16px;">
      This number appears on your digital membership card and giving receipts.
    </p>
    ` : ''}

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0;">
      Open the Churza app to access your full church experience. 
      God bless you! 🙏
    </p>
  `, churchName),
});

/**
 * addedToGroupOptions — Sent when a member is added to a cell group.
 */
const addedToGroupOptions = (recipient, firstName, groupName, churchName, { leaderName, meetingDay, meetingTime, meetingLocation } = {}) => ({
    from: `"${churchName}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: recipient,
    subject: `You've been added to ${groupName}`,
    html: _wrap(`
    <h2 style="color:#0B1F3A;font-size:22px;margin:0 0 16px;">You've joined ${groupName}! 🙌</h2>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Hello <strong>${firstName}</strong>,
    </p>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      You have been added to <strong>${groupName}</strong> cell group 
      at <strong>${churchName}</strong>.
    </p>

    ${meetingDay || meetingTime || meetingLocation || leaderName ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;border:1px solid #E8E0CC;border-radius:8px;margin:0 0 20px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:14px;color:#0B1F3A;"><strong>Group details:</strong></p>
          ${leaderName ? `<p style="margin:0 0 6px;font-size:14px;color:#444;">👤 <strong>Leader:</strong> ${leaderName}</p>` : ''}
          ${meetingDay ? `<p style="margin:0 0 6px;font-size:14px;color:#444;">📅 <strong>Meets every:</strong> ${meetingDay}</p>` : ''}
          ${meetingTime ? `<p style="margin:0 0 6px;font-size:14px;color:#444;">🕖 <strong>Time:</strong> ${meetingTime}</p>` : ''}
          ${meetingLocation ? `<p style="margin:0;font-size:14px;color:#444;">📍 <strong>Location:</strong> ${meetingLocation}</p>` : ''}
        </td>
      </tr>
    </table>
    ` : ''}

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0;">
      Open the Churza app to connect with your group members and join the group chat.
    </p>
  `, churchName),
});

/**
 * leaderAppointedOptions — Sent when a member is appointed as cell leader.
 */
const leaderAppointedOptions = (recipient, firstName, groupName, churchName) => ({
    from: `"${churchName}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: recipient,
    subject: `You've been appointed leader of ${groupName}`,
    html: _wrap(`
    <h2 style="color:#0B1F3A;font-size:22px;margin:0 0 16px;">Congratulations, ${firstName}! 👑</h2>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      You have been appointed as the cell group leader of 
      <strong>${groupName}</strong> at <strong>${churchName}</strong>.
    </p>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      As a cell leader you can now:
    </p>

    <ul style="color:#444;font-size:15px;line-height:2;margin:0 0 16px;padding-left:20px;">
      <li>Take attendance after each meeting</li>
      <li>Send announcements to your group members</li>
      <li>Manage your group chat in the Churza app</li>
    </ul>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0;">
      May God give you wisdom and grace to lead your group well. 🙏
    </p>
  `, churchName),
});

/**
 * passwordResetOptions — Sent when a user requests a password reset.
 * Uses a 4-digit code — no URL needed, user enters it in the app.
 */
const passwordResetOptions = (recipient, firstName, code) => ({
    from: `"Churza" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: recipient,
    subject: 'Your Churza password reset code',
    html: _wrap(`
    <h2 style="color:#0B1F3A;font-size:22px;margin:0 0 16px;">Password reset code</h2>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Hello <strong>${firstName}</strong>,
    </p>

    <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 24px;">
      We received a request to reset your Churza password.
      Enter the code below in the app to continue.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td align="center">
          <table cellpadding="0" cellspacing="0" style="background:#0B1F3A;border-radius:12px;padding:24px 48px;">
            <tr>
              <td align="center">
                <p style="margin:0 0 8px;color:rgba(255,255,255,0.6);font-size:12px;letter-spacing:1px;text-transform:uppercase;">Your reset code</p>
                <p style="margin:0;font-size:48px;font-weight:700;color:#C9A84C;letter-spacing:12px;font-family:monospace;">
                  ${code}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="color:#999;font-size:13px;line-height:1.6;margin:0 0 8px;">
      ⏱ This code expires in <strong>10 minutes</strong>.
    </p>
    <p style="color:#999;font-size:13px;margin:0;">
      If you did not request a password reset, ignore this email — 
      your password will not change.
    </p>
  `),
});

// ─────────────────────────────────────────────────────────

module.exports = {
    send,
    sendEmail,
    welcomeOptions,
    membershipApprovedOptions,
    addedToGroupOptions,
    leaderAppointedOptions,
    passwordResetOptions, // passwordResetOptions(email, firstName, code)
};