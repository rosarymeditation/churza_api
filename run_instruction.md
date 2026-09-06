# Run Instructions — Church API (Churza)

## 1. Prerequisites

- Node.js 18 or later — check with `node -v`
- npm
- A MongoDB Atlas cluster (or local MongoDB)
- A Stripe account (test mode keys are fine for local dev)
- A Cloudinary account
- A OneSignal app (for push notifications)
- `git`

## 2. Clone and Install

```bash
git clone <repo-url>
cd church_api
npm install
```

## 3. Configure Environment Variables

```bash
cp .env.example .env
```

Fill in real values in `.env`:

- `MONGODB_URI` — your real connection string. **This project reads
  `MONGODB_URI`, not `MONGO_URI`** — double check this matches whatever
  `server.js` actually calls `mongoose.connect()` with, since a mismatch
  here causes a silent `undefined` connection string error.
- `JWT_SECRET` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` — use your Stripe
  **test mode** keys (`sk_test_...` / `pk_test_...`) for local
  development. Only use live keys in a real production deployment, and
  never paste live keys into chat, tickets, or commits.
- `CLOUDINARY_*` — from your Cloudinary dashboard.
- `ONESIGNAL_APP_ID` / `ONESIGNAL_API_KEY` — from your OneSignal app
  settings.
- `SMTP_USER` / `SMTP_PASS` — use a dedicated, unique password for this
  mailbox. Do not reuse a password from another service or another repo.

Confirm `.env` is git-ignored:
```bash
git check-ignore .env
```
This should print `.env`. If it prints nothing, add it to `.gitignore`
before continuing.

## 4. Start the Server

```bash
npm start
```

You should see console output confirming MongoDB connected and the
server listening. Verify:
```bash
curl http://localhost:5000/health
```

## 5. Stripe Webhook Setup (local development)

Stripe webhooks need a public URL to call back to. For local dev, use
the Stripe CLI:

```bash
stripe listen --forward-to localhost:5000/api/payments/webhook
```

This prints a webhook signing secret (`whsec_...`) — put that in your
`.env` as `STRIPE_WEBHOOK_SECRET`.

**Confirm the webhook route is registered before `express.json()`** in
`server.js` — if it isn't, signature verification will fail even with
the correct secret. See the Troubleshooting section of the README.

## 6. Run Tests

```bash
npm install --save-dev jest    # if not already installed
npm test
```

Run a single suite:
```bash
npx jest test/controllers/paymentController.test.js
```

## 7. Security Check Before Deploying

```bash
gitleaks detect --source . --verbose
```

If it reports zero leaks (or only documented known-safe entries in
`.gitleaksignore`), you're clear. If it finds a real credential, rotate
it at the provider first — don't just remove it from the file and
commit again.

## 8. Deploying

- Set `NODE_ENV=production`
- Set all secrets via your host's environment variable configuration,
  not committed files
- Switch `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY` to live keys only
  once you're genuinely ready to accept real payments — confirm the
  webhook secret is also updated to match the live-mode webhook endpoint
  configured in the Stripe Dashboard (test and live mode have separate
  webhook secrets)
- Confirm cron jobs (`eventReminderCron`, `giftAidReminderCron`) are only
  scheduled once per running instance — if you deploy multiple server
  instances behind a load balancer, scheduling cron inside `server.js`
  as written will run the job once per instance, which may send
  duplicate notifications

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `The uri parameter to openUri() must be a string, got "undefined"` | Env var name mismatch | Confirm `.env` uses the exact variable name `server.js` reads (`MONGODB_URI`) |
| Route always returns `501 Handler not implemented yet` | Route file imports the wrong controller, or a method name typo | `node -e "console.log(require('./controllers/X'))"` to check real exports |
| `Cannot find module '../controllers/paymentLinkController'` | A route file still requires a controller that doesn't exist | Remove that route file's `require(...)(app)` line from `server.js`, not just its internal body |
| Stripe webhook signature always fails | Route registered after `express.json()` | Move webhook route registration above the body parser in `server.js` |
| Password reset endpoint crashes with `bcrypt is not defined` | `resetPassword` calls `bcrypt.hash()` without requiring `bcrypt` | Add `const bcrypt = require("bcryptjs");` at the top of `userController.js`, or switch to the `passwordHash = plainValue` + pre-save-hook pattern used elsewhere in the same file |
