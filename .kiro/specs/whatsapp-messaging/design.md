# Design — WhatsApp Number Validation & Messaging MVP

## 1. Architecture overview

Server-rendered monolith (Express + EJS) with a background worker running **in the same
Node process** by default (node-cron polling a DB-backed queue). No SPA. No hard Redis
dependency.

```
                          ┌───────────────────────────────────────────┐
                          │                Browser (admin)             │
                          │   EJS views + Bootstrap + small JS polling  │
                          └───────────────┬───────────────────────────-┘
                                          │ HTTPS (session cookie)
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                            Express application                                  │
│                                                                                 │
│  Middleware: session, csrf, body/urlencoded, raw-body(for webhook signature)    │
│                                                                                 │
│  Routes                                                                         │
│   /login /logout                 → auth controller                             │
│   /                              → dashboard                                    │
│   /validate/single (Tier A/B)    → validation controller ─┐                     │
│   /validate/bulk (CSV, Tier A)   → validation controller  │                     │
│   /messages/single               → message controller ────┼──► WhatsAppService  │
│   /bulk (create job, CSV)        → bulk controller        │      (axios → Meta) │
│   /bulk/:id (detail/progress)    → bulk controller        │                     │
│   /webhook (GET verify/POST)     → webhook controller ◄───┘  (Meta calls in)    │
│                                                                                 │
│  Services                                                                       │
│   PhoneService  (libphonenumber-js)                                             │
│   WhatsAppService (Meta Cloud API wrapper: send template / text)                │
│   QueueService  (enqueue bulk items; DB-backed)                                 │
│   Worker (node-cron tick → claim pending items → send → update)                 │
│                                                                                 │
│  Data access: models over mysql2/promise                                        │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐          ┌───────────────────────────┐
                        │      MySQL        │          │  Meta WhatsApp Cloud API   │
                        │  (all app state)  │          │  graph.facebook.com/v21.0  │
                        └──────────────────┘          └───────────────────────────┘
```

**Request → send → status lifecycle:**
1. Admin submits a send (single) or uploads a CSV (bulk).
2. Single send calls `WhatsAppService` immediately; bulk enqueues items and returns.
3. Worker claims pending items, calls Meta with a delay between each, stores `wamid`.
4. Meta later POSTs status callbacks to `/webhook`; controller matches by `wamid` and
   updates `messages.status`.
5. UI polls job/message endpoints for progress.

## 2. Technology choices & justifications

- **DB driver: `mysql2/promise` (raw SQL), not Sequelize.** The schema is small and
  fixed, the queries are simple, and raw SQL keeps the MVP dependency-light and the
  worker's atomic "claim next pending item" `UPDATE ... WHERE status='pending' ... LIMIT 1`
  explicit and easy to reason about. Sequelize's abstraction adds weight without payoff
  at this size. We use a thin migration runner instead of an ORM.
- **Views: EJS + Bootstrap** per the brief — fastest path to a working dashboard, no build
  step, deploys cleanly on Hostinger.
- **Queue: DB-backed table + `node-cron` worker (default).** Works with no Redis, is
  crash-safe (state lives in MySQL), and resumes pending items on restart. A `QUEUE_DRIVER`
  env flag leaves room for an optional BullMQ+Redis path later without changing callers.
- **HTTP: `axios`** with a shared instance (base URL, auth header, timeout).
- **Validation: `libphonenumber-js`** for Tier A.
- **CSV: `multer`** (upload) + `csv-parse` (parse).
- **Auth: `express-session` + `bcryptjs`**, single admin seeded via migration. `csurf`-style
  CSRF protection on state-changing forms.

## 3. MySQL schema

All tables InnoDB, `utf8mb4`. Timestamps `DATETIME` in UTC (app sets them / `CURRENT_TIMESTAMP`).

```sql
-- admins: single MVP admin (seeded)
CREATE TABLE admins (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- contacts: known recipients (deduped by e164)
CREATE TABLE contacts (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  e164        VARCHAR(20) NOT NULL UNIQUE,
  raw_input   VARCHAR(64) NULL,
  country     VARCHAR(4)  NULL,
  name        VARCHAR(120) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- validation_results: one row per validation attempt (Tier A or B)
CREATE TABLE validation_results (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  batch_id     VARCHAR(36) NULL,             -- groups a bulk upload; NULL for single
  raw_input    VARCHAR(64) NOT NULL,
  e164         VARCHAR(20) NULL,
  country      VARCHAR(4)  NULL,
  number_type  VARCHAR(20) NULL,             -- mobile/fixed_line/etc from libphonenumber
  check_type   ENUM('format','deliverability') NOT NULL,
  is_valid     TINYINT(1) NOT NULL,          -- Tier A format validity
  status       ENUM('valid','invalid','accepted','failed','pending') NOT NULL,
  reason       VARCHAR(255) NULL,            -- error/why
  wamid        VARCHAR(128) NULL,            -- set for Tier B accepted sends
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_batch (batch_id),
  INDEX idx_e164 (e164)
);

-- messages: every outbound message (single or bulk item), status tracked via webhook
CREATE TABLE messages (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  wamid         VARCHAR(128) NULL UNIQUE,    -- Meta message id (null until accepted)
  to_e164       VARCHAR(20) NOT NULL,
  direction     ENUM('outbound') NOT NULL DEFAULT 'outbound',
  msg_type      ENUM('template','text') NOT NULL,
  template_name VARCHAR(120) NULL,
  language      VARCHAR(15)  NULL,
  body_preview  VARCHAR(500) NULL,           -- rendered text / template summary
  status        ENUM('accepted','sent','delivered','read','failed') NOT NULL DEFAULT 'accepted',
  error_code    VARCHAR(40)  NULL,
  error_title   VARCHAR(255) NULL,
  error_detail  VARCHAR(500) NULL,
  bulk_job_item_id BIGINT UNSIGNED NULL,     -- link back to bulk item if applicable
  accepted_at   DATETIME NULL,
  sent_at       DATETIME NULL,
  delivered_at  DATETIME NULL,
  read_at       DATETIME NULL,
  failed_at     DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_to (to_e164)
);

-- bulk_jobs: one per CSV send job
CREATE TABLE bulk_jobs (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name          VARCHAR(160) NULL,
  template_name VARCHAR(120) NOT NULL,
  language      VARCHAR(15)  NOT NULL,
  msg_type      ENUM('template','text') NOT NULL DEFAULT 'template',
  variables_map JSON NULL,                   -- how CSV columns map to template vars
  status        ENUM('pending','running','completed','failed','paused') NOT NULL DEFAULT 'pending',
  total_count   INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count    INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count  INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- bulk_job_items: one per recipient in a job (the queue)
CREATE TABLE bulk_job_items (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  job_id       BIGINT UNSIGNED NOT NULL,
  to_e164      VARCHAR(20) NULL,
  raw_input    VARCHAR(64) NOT NULL,
  variables    JSON NULL,                    -- resolved per-row template variables
  status       ENUM('pending','processing','sent','failed','skipped_invalid') NOT NULL DEFAULT 'pending',
  attempts     INT UNSIGNED NOT NULL DEFAULT 0,
  wamid        VARCHAR(128) NULL,
  error_detail VARCHAR(500) NULL,
  next_attempt_at DATETIME NULL,             -- for backoff
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_job (job_id),
  INDEX idx_claim (status, next_attempt_at),
  CONSTRAINT fk_item_job FOREIGN KEY (job_id) REFERENCES bulk_jobs(id) ON DELETE CASCADE
);

-- webhook_events: raw audit log of every inbound callback (idempotency + debugging)
CREATE TABLE webhook_events (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  event_hash  VARCHAR(64) NOT NULL,          -- dedupe key (wamid+status+timestamp)
  wamid       VARCHAR(128) NULL,
  payload     JSON NOT NULL,
  processed   TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event_hash (event_hash),
  INDEX idx_wamid (wamid)
);
```

**Status monotonicity:** message statuses have a rank
`accepted(0) < sent(1) < delivered(2) < read(3)`, `failed` is terminal-ish. The webhook
handler only advances status if the incoming rank is higher (a late `delivered` never
overwrites `read`). `failed` is applied only if the message is not already `read`.

## 4. API / route list

| Method | Path                     | Auth | Purpose |
|--------|--------------------------|------|---------|
| GET    | `/login`                 | no   | login form |
| POST   | `/login`                 | no   | authenticate |
| POST   | `/logout`                | yes  | destroy session |
| GET    | `/`                      | yes  | dashboard summary |
| GET    | `/validate`              | yes  | validation page |
| POST   | `/validate/single`       | yes  | Tier A format check (JSON) |
| POST   | `/validate/deliverability` | yes | Tier B probe send (JSON) |
| POST   | `/validate/bulk`         | yes  | CSV upload → Tier A report |
| GET    | `/messages`              | yes  | single-send page + recent messages |
| POST   | `/messages/single`       | yes  | send one (template/text) |
| GET    | `/messages/:id/status`   | yes  | JSON status (for polling) |
| GET    | `/bulk`                  | yes  | list jobs + create form |
| POST   | `/bulk`                  | yes  | create job from CSV |
| GET    | `/bulk/:id`              | yes  | job detail + items |
| GET    | `/bulk/:id/progress`     | yes  | JSON progress (for polling) |
| POST   | `/bulk/:id/retry-failed` | yes  | re-queue failed items (stretch) |
| GET    | `/webhook`               | no*  | Meta verification handshake |
| POST   | `/webhook`               | no*  | Meta status callbacks (signature-verified) |
| GET    | `/health`                | no   | liveness probe |

`no*` = not session-auth; secured by verify token (GET) and `X-Hub-Signature-256` (POST).

## 5. Meta Cloud API integration points

Base: `https://graph.facebook.com/{GRAPH_VERSION}/{PHONE_NUMBER_ID}` with header
`Authorization: Bearer {WHATSAPP_TOKEN}`.

### 5.1 Send template message
`POST /{PHONE_NUMBER_ID}/messages`
```json
{
  "messaging_product": "whatsapp",
  "to": "15551234567",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": { "code": "en_US" },
    "components": [
      { "type": "body",
        "parameters": [ { "type": "text", "text": "Alice" } ] }
    ]
  }
}
```
Success → `{ "messages": [ { "id": "wamid.XXXX" } ] }` → store `wamid`, status `accepted`.

### 5.2 Send free-text (session only)
`POST /{PHONE_NUMBER_ID}/messages`
```json
{
  "messaging_product": "whatsapp",
  "to": "15551234567",
  "type": "text",
  "text": { "body": "Hi there" }
}
```

### 5.3 Error shape (rejected)
```json
{ "error": { "message": "...", "code": 131030, "error_data": { "details": "..." }, "fbtrace_id": "..." } }
```
`WhatsAppService` normalizes this to `{ ok:false, code, title, detail }`.

### 5.4 Webhook verification (GET `/webhook`)
Meta calls with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`. Respond with the
raw `hub.challenge` as `200 text/plain` **iff** `hub.verify_token === WEBHOOK_VERIFY_TOKEN`;
else `403`.

### 5.5 Webhook status callback (POST `/webhook`)
```json
{
  "object": "whatsapp_business_account",
  "entry": [ { "changes": [ { "field": "messages", "value": {
    "statuses": [ {
      "id": "wamid.XXXX",
      "status": "delivered",
      "timestamp": "1730000000",
      "recipient_id": "15551234567",
      "errors": [ { "code": 131026, "title": "Message undeliverable" } ]
    } ]
  } } ] } ]
}
```
Verify `X-Hub-Signature-256 = 'sha256=' + HMAC_SHA256(appSecret, rawBody)` using the **raw**
request body. Then for each status: dedupe via `webhook_events`, match `messages.wamid`,
advance status monotonically, store timestamps/errors. Always `200` unless signature fails
(`401`).

## 6. Queue / worker design (DB-backed, no Redis)

- **Enqueue:** bulk import inserts `bulk_job_items` with `status='pending'`, `next_attempt_at=NOW()`, sets `bulk_jobs.status='running'` when items exist.
- **Worker tick (`node-cron`, every `WORKER_INTERVAL_SEC`, default 5s):**
  1. Guard against overlapping ticks with an in-process `isRunning` lock.
  2. Claim up to `WORKER_BATCH` items atomically:
     `UPDATE bulk_job_items SET status='processing' WHERE status='pending' AND next_attempt_at<=NOW() ORDER BY id LIMIT ? ` then `SELECT` the claimed ids (or claim one-by-one with `LIMIT 1` for strict single-flight). MVP claims a small batch and processes sequentially.
  3. For each claimed item, wait `SEND_DELAY_MS` between sends (rate limit), call `WhatsAppService`, then:
     - success → `status='sent'`, store `wamid`, insert a `messages` row (`accepted`), bump `bulk_jobs.sent_count`.
     - transient failure (HTTP 429/5xx, network) and `attempts < MAX_ATTEMPTS` → back to `pending`, `attempts++`, `next_attempt_at = NOW() + backoff(attempts)`.
     - permanent failure or attempts exhausted → `status='failed'`, store error, bump `failed_count`.
  4. When a job has no remaining `pending`/`processing` items, set `bulk_jobs.status='completed'`.
- **Crash safety:** state is in MySQL. On restart, a startup reconciler resets any
  `processing` items older than a threshold back to `pending` (assume the previous run died
  mid-flight) — and because a `messages` row + `wamid` is only written on confirmed success,
  an item reset to pending that had actually been sent is guarded by checking for an existing
  `wamid` before re-sending.
- **Rate-limit backoff:** on Meta 429 / rate-limit codes, multiply delay
  (`backoff = base * 2^attempts`, capped) and pause the tick briefly.
- **Optional Redis path:** `QUEUE_DRIVER=bullmq` swaps the enqueue+worker for BullMQ; the
  controller/service contract (`enqueueJob`, `processItem`) stays identical. Not built in MVP
  unless requested.

## 7. Security & config

Env vars (documented in `.env.example`):
```
PORT, NODE_ENV, SESSION_SECRET
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
ADMIN_USERNAME, ADMIN_PASSWORD            # used by seed only
GRAPH_VERSION=v21.0
WHATSAPP_TOKEN, PHONE_NUMBER_ID, WABA_ID
APP_SECRET                                 # webhook signature
WEBHOOK_VERIFY_TOKEN
PROBE_TEMPLATE_NAME, PROBE_TEMPLATE_LANG    # Tier B deliverability probe
SEND_DELAY_MS=1000, WORKER_INTERVAL_SEC=5, WORKER_BATCH=5, MAX_ATTEMPTS=3
QUEUE_DRIVER=db                            # db | bullmq
REDIS_URL                                   # only if bullmq
```
- Secrets only via env; never logged or rendered.
- Webhook POST uses raw-body capture middleware scoped to `/webhook` for signature checks.
- CSRF tokens on all forms; sessions httpOnly + secure (behind HTTPS on Hostinger).

## 8. Project structure

```
src/
  app.js                 # express app wiring
  server.js              # start http + worker
  config/index.js        # env → typed config
  db/pool.js             # mysql2 pool
  db/migrate.js          # migration runner
  db/migrations/*.sql
  db/seed.js             # seed admin
  middleware/{auth,csrf,rawBody,errorHandler}.js
  services/phoneService.js
  services/whatsappService.js
  services/queueService.js
  worker/worker.js       # node-cron tick + reconciler
  controllers/{auth,validation,message,bulk,webhook}.js
  routes/index.js
  models/{admin,contact,validationResult,message,bulkJob,bulkJobItem,webhookEvent}.js
  views/*.ejs
  public/                # bootstrap + small polling js
.env.example
```
