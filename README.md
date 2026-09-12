# WhatsApp Number Validation & Messaging MVP

A Node.js (Express + EJS) + MySQL web app for a single admin to validate phone
numbers and send WhatsApp messages through the **official Meta WhatsApp Cloud
API**. Supports single and bulk sends, template and free-text messages, a
queued/rate-limited bulk worker, and per-message delivery status driven by Meta
webhook callbacks.

- Validation is two-tier: **Tier A** structural/format checks (`libphonenumber-js`,
  free and instant) and **Tier B** deliverability (confirmed only by attempting a
  real send — the Cloud API has no standalone "check number" endpoint).
- Bulk sends are **queued and rate-limited**, never a tight loop.
- The default queue is **DB-backed** (a MySQL table polled by a `node-cron`
  worker) so it runs **without Redis**. BullMQ + Redis is an opt-in path.

## Prerequisites

- **Node.js** 18+ and npm.
- **MySQL** 8.x (or MariaDB 10.5+) with a database you can create tables in.
- A **Meta WhatsApp Cloud API** app: an access token, a phone number id, an app
  secret (for webhook signature verification), and a webhook verify token.
- For Meta in staging/production: a **public HTTPS URL** that Meta can reach
  (Meta only calls HTTPS endpoints). The app provides `/privacy-policy` for the
  Meta Privacy Policy URL and `/webhook` for WhatsApp callbacks.

## Environment setup

All configuration comes from environment variables. Secrets are **never**
committed — `.env` is gitignored; only `.env.example` is tracked.

1. Copy the example file and fill in real values:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env`. Key variables (see `.env.example` for the full list and defaults):

   | Variable | Purpose |
   |---|---|
   | `PORT`, `NODE_ENV` | App port and environment (`development` / `production`). |
   | `SESSION_SECRET` | Long random string for signing session cookies. |
   | `SESSION_COOKIE_SECURE` | Force secure cookies. Auto-on when `NODE_ENV=production`. |
   | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection. |
   | `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Seed the single admin (used by `npm run seed` only). |
   | `GRAPH_VERSION`, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `WABA_ID` | Meta Cloud API. |
   | `APP_SECRET` | Verifies the `X-Hub-Signature-256` webhook signature. |
   | `WEBHOOK_VERIFY_TOKEN` | Matched during the Meta GET verification handshake. |
   | `PROBE_TEMPLATE_NAME`, `PROBE_TEMPLATE_LANG` | Template used for Tier B deliverability probes. |
   | `SEND_DELAY_MS`, `WORKER_INTERVAL_SEC`, `WORKER_BATCH`, `MAX_ATTEMPTS` | Bulk worker rate limit / retry tuning. |
   | `QUEUE_DRIVER` | `db` (default, no Redis) or `bullmq` (opt-in). |
   | `REDIS_URL` | Only needed when `QUEUE_DRIVER=bullmq`. |
   | `UPLOAD_MAX_BYTES` | Max CSV upload size. |

   > Secrets (Meta token, app secret, DB password, session secret, etc.) come
   > from the environment only. They are never logged or rendered in any view.

## Install, migrate, seed, run

```bash
npm install          # install dependencies

npm run migrate      # create the MySQL schema (creates the DB if missing)
npm run seed         # create the admin user from ADMIN_USERNAME/ADMIN_PASSWORD

npm start            # start the app (and the background worker)
# or, for development with auto-reload:
npm run dev
```

Once running, open `http://localhost:3000` and log in with the seeded admin
credentials. `GET /health` returns a 200 JSON liveness probe.

The background bulk worker starts automatically with the app when
`QUEUE_DRIVER=db` (the default). It runs a startup reconciler (to resume any
interrupted job items crash-safely) and then polls for pending work on an
interval. On `SIGINT`/`SIGTERM` the app stops the worker and closes the HTTP
server gracefully.

You can re-queue a completed job's failed items from its detail page: the
**Retry failed** button (shown when a job has failures) POSTs to
`/bulk/:id/retry-failed`, which flips those items back to `pending` (guarded so
an already-accepted item is never re-sent) and sets the job `running` again so
the worker resumes it.

### Optional: BullMQ + Redis queue

The default `db` driver needs no Redis and no extra packages. To run the queue
on BullMQ + Redis instead (e.g. when you have provisioned Redis):

1. Install the optional packages (they are declared under
   `optionalDependencies`, not installed by the default `npm install`):

   ```
   npm install bullmq ioredis
   ```

2. Set `QUEUE_DRIVER=bullmq` and `REDIS_URL=redis://HOST:6379` in `.env`.
3. Start the app. Enqueue still persists jobs/items to MySQL (so history,
   progress, and retry-failed are unchanged); items are drained by a BullMQ
   worker instead of the node-cron poller. If `bullmq`/`ioredis` or `REDIS_URL`
   are missing, the app fails fast with a clear, actionable error.

## Configuring the Meta webhook

The webhook delivers per-message status updates (sent / delivered / read /
failed). Meta requires an HTTPS endpoint.

- **Callback URL:** `https://YOUR_DOMAIN/webhook`
- **Verify token:** the value you set in `WEBHOOK_VERIFY_TOKEN`.

Flow:

1. **GET `/webhook` (verification handshake).** Meta calls with
   `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`. The app echoes
   the raw `hub.challenge` with `200 text/plain` **only if** the token matches
   `WEBHOOK_VERIFY_TOKEN`; otherwise it responds `403`.
2. **POST `/webhook` (status callbacks).** Each callback's
   `X-Hub-Signature-256` header is verified against the raw request body using
   `APP_SECRET`. Invalid signatures get `401`. Valid callbacks are deduplicated,
   matched to a message by `wamid`, and advance the message status
   monotonically. The handler responds `200` quickly and is idempotent.

Subscribe to the **messages** field in the Meta app's webhook configuration so
status events are delivered.

> **HTTPS is required.** Meta will not call an HTTP endpoint. In production this
> is provided by Hostinger's TLS. For local testing, put an HTTPS tunnel (e.g.
> a reverse proxy or tunneling service) in front of the local app and register
> that HTTPS URL with Meta.

## Deploying to Hostinger

Target: a Hostinger Node.js app deployed from a GitHub repository. No guaranteed
Redis, so the default `QUEUE_DRIVER=db` is used (worker runs in-process).

1. **Connect the repo.** In the Hostinger panel, create a Node.js application
   and point it at this GitHub repository / branch.
2. **Set the start command** to `npm start` (entry point `src/server.js`).
3. **Provision MySQL** in the panel and note the host, port, database, user, and
   password.
4. **Set environment variables** via the panel (do not commit `.env`): all the
   variables listed above, especially `NODE_ENV=production`, a strong
   `SESSION_SECRET`, the DB credentials, and the Meta secrets. With
   `NODE_ENV=production` secure cookies turn on automatically; the app already
   sets `trust proxy` so secure cookies work behind Hostinger's TLS terminator.
5. **Run the one-time DB setup** from the panel's terminal (or a deploy hook):

   ```bash
   npm install
   npm run migrate
   npm run seed
   ```

6. **Ensure HTTPS is enabled** for the domain, then register
   `https://YOUR_DOMAIN/webhook` and the verify token in the Meta app and
   subscribe to the **messages** field.
7. **Keep `QUEUE_DRIVER=db`** unless you have provisioned Redis; the bulk worker
   runs inside the same Node process and survives restarts because job state
   lives in MySQL.

## Running tests

```bash
npm test
```

Runs the Jest + Supertest suite (unit and integration tests) serially and exits
cleanly. Tests mock the database and the Meta API, so no live MySQL or network
access is required to run them.

## Project layout

```
src/
  app.js                 # express app wiring (helmet, session, CSRF, routes, error handler)
  server.js              # boots HTTP server + background worker, graceful shutdown
  config/index.js        # env -> typed config (secrets read here only)
  db/                    # mysql2 pool, migration runner, migrations, seed
  middleware/            # auth, csrf, rawBody (webhook), flash, error handling
  services/              # phoneService, whatsappService, queueService
  worker/worker.js       # node-cron tick + startup reconciler (DB queue)
  controllers/           # auth, validation, message, bulk, webhook
  models/                # data access over mysql2/promise
  views/                 # EJS templates + Bootstrap
test/                    # Jest + Supertest tests
```
