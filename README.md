# Church API (Churza)

A multi-tenant Node.js/Express backend for church community management —
membership onboarding, attendance tracking, online giving, sermons, prayer
requests, events, cell groups with chat, and live streaming. A single
deployment serves many churches; every resource is scoped through a
user's `Membership` record rather than a single fixed tenant field.

## Tech Stack

- **Runtime**: Node.js (Express)
- **Database**: MongoDB via Mongoose
- **Auth**: JWT, bcrypt password hashing
- **Payments**: Stripe Connect (Express accounts) for member giving; Paystack
  supported as an alternate gateway on some transaction paths
- **Media**: Cloudinary (profile photos, sermon audio, chat files/voice notes)
- **Push notifications**: OneSignal
- **Realtime**: Socket.IO (cell group chat, live viewer counts)
- **Scheduled jobs**: node-cron (event reminders, Gift Aid reminders)
- **Security**: Helmet, CORS, express-rate-limit
- **Testing**: Jest

## Project Structure

```
church_api/
├── server.js                      # App entrypoint — middleware, DB connection, route + cron wiring
├── controllers/
│   ├── userController.js          # Register, login, profile, admin user management
│   ├── churchController.js        # Church CRUD, join-by-code, members, sermons, prayer, events, announcements
│   ├── attendanceController.js    # Check-in sessions, member/usher check-in, reports
│   ├── paymentController.js       # Stripe Connect onboarding + member giving (PaymentIntents)
│   ├── givingController.js        # Giving transactions/pledges (alternate/legacy giving flow)
│   ├── sermonController.js        # Sermon upload, listing, view/download counters
│   ├── prayerController.js        # Prayer wall
│   ├── eventController.js         # Events, RSVPs, event check-in
│   ├── announcementController.js  # Announcements with push notification fan-out
│   ├── cellGroupController.js     # Cell group CRUD and member assignment
│   ├── chatController.js          # Cell group chat, file/voice uploads, leader assignment
│   ├── liveController.js          # YouTube-based live streaming sessions
│   └── stripeController.js        # (RentFlow-style) standalone Stripe connect status — see note below
├── models/
│   ├── User.js
│   ├── Membership.js               # Join table: user ↔ church, carries role + status
│   ├── Church.js
│   ├── Attendance.js / AttendanceSession.js
│   ├── GivingTransaction.js / Pledge.js
│   ├── Sermon.js
│   ├── PrayerRequest.js
│   ├── Event.js / EventRsvp.js
│   ├── Announcement.js
│   ├── CellGroup.js / ChatMessage.js
│   ├── LiveSession.js
│   └── Notification.js
├── routes/                         # One file per resource, each exports `(app) => {...}`
├── middleware/
│   ├── auth.js                     # protect, restrictTo, requireChurchRole, requireActiveMembership, optionalAuth
│   └── errorHandler.js
├── utils/
│   ├── email.js
│   ├── churchNotifications.js      # Push notification helpers + cron job functions
│   └── socketHandler.js
├── test/controllers/                # Jest test suites
├── .env.example
└── package.json
```

## Core Features

### Authentication & Onboarding
- Registration collects a `userIntent` (`member` or `admin`) from the
  Flutter app's "Who are you?" screen. This is **not stored** — it's only
  echoed back in the response as a `nextScreen` routing hint, so the app
  knows whether to send a new user to "join a church" or "register a new
  church" without a second API call.
- Login returns the same kind of routing hints (`nextScreen`, `hasChurch`,
  `activeMembershipId`, `activeChurchId`) computed from the user's most
  recent `Membership`, again saving the app a round trip on startup.
- Role-based access is enforced per-church via `Membership.role`
  (`admin`, `pastor`, `cell_leader`, `worker`, `deacon`, `member`), not a
  single global role — a user can hold different roles in different
  churches. `requireChurchRole(...)` and `requireActiveMembership`
  middleware read `churchId` from params/body/query and attach
  `req.membership` for downstream handlers.

### Attendance
- Admins/pastors open a check-in `AttendanceSession` for a service; any
  previously-open session for the church is automatically closed first.
- Members self-check-in with a single tap; ushers can also manually check
  in members who don't have the app open. Both paths guard against
  duplicate same-day check-ins and return the existing record instead of
  creating a second one.

### Giving
- **Two parallel giving implementations exist in this codebase** —
  `paymentController.js` (Stripe Connect + PaymentIntents, with a
  configurable platform fee and a UK Gift Aid report) and
  `givingController.js` (a transaction/pledge model supporting cash
  entries and a Paystack-style webhook). Confirm with the team which one
  is the actively used path before extending either — see
  [Architecture Notes](#architecture-notes).
- Churches connect their own Stripe Express account; the platform takes a
  small fee (`PLATFORM_FEE_RATE`, default 1.5%, with a minimum floor) via
  Stripe's `application_fee_amount` + `transfer_data`.
- A Gift Aid report aggregates a UK tax year's (6 Apr – 5 Apr) giving per
  member for reclaim purposes.

### Cell Groups & Chat
- Cell groups have a leader and a member list; REST handles group
  management, file/voice uploads (via Cloudinary), and message history —
  Socket.IO handles realtime text delivery once a message is saved.

### Sermons, Prayer Wall, Events, Announcements
- Standard CRUD with publish/draft states; publishing (or scheduling)
  triggers push notifications to active members via OneSignal.
- Events support RSVP with optional capacity limits and door check-in.

### Live Streaming
- Admins start a session backed by a YouTube URL (parsed to extract the
  video ID from watch/short/live link formats); members can "join" to
  register a live viewer count. Ending a session can optionally archive
  it as a `Sermon` automatically.

### Admin-created Members
- Admins can manually add a member who doesn't have the app yet — creates
  a `User` with a temporary password and `mustChangePassword: true`, and
  emails them their login details.

## Getting Started

### Prerequisites
- Node.js 18+
- A MongoDB Atlas cluster (or local MongoDB)
- Stripe account (test mode is fine for development)
- Cloudinary account
- OneSignal app (for push notifications)

### Installation
```bash
git clone <repo-url>
cd church_api
npm install
```

### Environment Setup
```bash
cp .env.example .env
```
Fill in real values. **Never commit `.env`.** See
[Environment Variables](#environment-variables) below.

### Running the Server
```bash
npm start
```
Health check:
```bash
curl http://localhost:5000/health
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development` or `production` |
| `PORT` | No (default `5000`) | Port the server listens on |
| `MONGODB_URI` | Yes | MongoDB connection string — **note the name is `MONGODB_URI`, not `MONGO_URI`** |
| `JWT_SECRET` | Yes | Signing secret for auth tokens, minimum 32 random characters |
| `JWT_EXPIRES_IN` | No (default `30d`) | JWT expiry duration |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of origins allowed by CORS |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Yes | Media uploads (photos, sermon audio, chat files) |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | Yes | Use **test** keys outside of real production |
| `STRIPE_CLIENT_ID` | Yes (for Stripe Connect disconnect flow) | |
| `STRIPE_WEBHOOK_SECRET` | Yes | Used to verify Stripe webhook signatures |
| `PLATFORM_FEE_RATE` | No (default `0.015`) | Fraction of each gift taken as a platform fee |
| `PAYSTACK_SECRET_KEY` | Only if using the Paystack giving path | |
| `ONESIGNAL_APP_ID` / `ONESIGNAL_API_KEY` | Yes | Push notifications |
| `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | Yes | Password resets, admin-created account emails |

## Running Tests

```bash
npm install --save-dev jest
npm test
```

Current coverage targets the highest-risk logic:
- **`paymentController`** — platform fee calculation (including the minimum-fee
  floor), duplicate-payment guarding, Stripe Connect status transitions
- **`attendanceController`** — session lifecycle, duplicate same-day
  check-in prevention, member vs. usher check-in paths
- **`userController`** — registration/login routing-hint branches,
  password change

Coverage gaps: `churchController`, `givingController`, `cellGroupController`,
`chatController`, `eventController`, `announcementController`,
`sermonController`, `prayerController`, `liveController` don't have test
suites yet.

## Architecture Notes

- **Multi-tenancy via `Membership`, not a single tenant field.** Unlike a
  simpler single-org model, a user's church access is determined by
  looking up their `Membership` record(s) — a user can belong to (and
  hold different roles in) more than one church. Every church-scoped
  route needs `requireChurchRole(...)` or `requireActiveMembership`,
  which resolve `churchId` from `req.params`, `req.body`, or `req.query`
  in that order — be careful that a route doesn't accept a spoofable
  `churchId` from the body when it should only trust the URL param.
- **Two giving implementations coexist** (`paymentController.js` and
  `givingController.js`). This needs resolving — either consolidate onto
  one, or clearly document which routes use which, since they have
  different data shapes (`amount` in pounds vs. pence, different status
  enums) and it's easy to accidentally read from the wrong one in a report.
- **`safe()` route wrapper masks missing controller methods.** Several
  route files use a `safe(fn)` helper that falls back to a `501 Not
  Implemented` response instead of crashing when a controller method is
  `undefined`. This is useful during active development but has silently
  hidden at least one real bug already (attendance routes pointing at
  the wrong controller entirely — see Troubleshooting). Periodically
  grep for `safe(controller\.` calls and confirm every referenced method
  actually exists and is spelled correctly on the right controller.
- **Stripe/Paystack webhooks need the raw request body.** Any route
  calling `stripe.webhooks.constructEvent(req.body, ...)` or verifying
  an HMAC signature against `req.body` **must** be registered with
  `express.raw({ type: "application/json" })` **before** the global
  `express.json()` body parser runs in `server.js` — not inside a normal
  route file that loads after it. This project has at least three
  webhook-shaped endpoints (`paymentController.handleWebhook`, a
  giving-webhook via Paystack, and a general Stripe webhook) — audit all
  of them together rather than fixing one at a time.

## Security Notes

- Passwords are hashed via bcrypt through a Mongoose pre-save hook —
  `User.create`/`save()` with a plain `passwordHash` value triggers this
  automatically. **`resetPassword` bypasses this pattern and calls
  `bcrypt.hash()` directly without requiring `bcrypt`** — this will throw
  at runtime the first time that endpoint is hit. Fix before relying on
  password reset in production.
- **Never reuse a password/secret across services.** This project has
  previously had the same password reused across its SMTP account and a
  MongoDB user — treat any credential found reused across services as
  compromised everywhere it's used, and rotate all instances, not just
  the one discovered.
- If a real Stripe, MongoDB, Cloudinary, OneSignal, or SMTP credential is
  ever pasted into a chat, ticket, or committed to git, rotate it at the
  provider immediately — this is true even if it's later removed from
  wherever it was exposed. Removing text does not revoke access that may
  already have occurred.
- Run `gitleaks detect --source . --verbose` before pushing to a shared
  branch. Document confirmed false positives in `.gitleaksignore` with a
  comment explaining why each is safe — never suppress a real finding.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The uri parameter to openUri() must be a string, got "undefined"` | `server.js` reads a different env var name than what's in `.env` | Confirm whether your `.env` uses `MONGODB_URI` or `MONGO_URI` and make `server.js` match exactly |
| A route always returns `501 Handler not implemented yet` | The route file's `controller` import points at the wrong controller file, or the method name doesn't match what that controller actually exports | Run `node -e "console.log(require('./controllers/X'))"` to see real exports; fix the import or the method name |
| `Cannot find module '../controllers/X'` on server start | A route file still requires a controller that was never created (e.g. an "omitted" feature) | Either finish the controller, or remove that route file's `require(...)(app)` call from `server.js` entirely — commenting out only the body of the route file still leaves the top-level `require` executing |
| Stripe/Paystack webhook signature verification fails intermittently or always | The webhook route is registered after `express.json()` runs, so the raw body is gone by the time the handler checks the signature | Move the webhook route registration into `server.js`, before `app.use(express.json())` |
| A controller test times out or asserts on an empty response | The controller's local `catchAsync` helper has extra `{ }` braces around its arrow body, so it doesn't return the inner promise | Either flush a macrotask tick (`setImmediate`) after calling the controller in tests, or remove the braces so `catchAsync` implicitly returns the promise |

## License

Proprietary — all rights reserved. Not licensed for redistribution.
