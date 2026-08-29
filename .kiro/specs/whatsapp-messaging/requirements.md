# Requirements — WhatsApp Number Validation & Messaging MVP

## Overview

A Node.js (Express) + MySQL web application that lets a single authenticated admin
user validate phone numbers and send WhatsApp messages through the **official Meta
WhatsApp Cloud API**. The app supports single and bulk operations, template and
free-text messages, queued rate-limited bulk sends, and per-message delivery status
driven by Meta webhook callbacks.

### Hard constraints (decided, not open for change)

- Messaging uses the **official Meta WhatsApp Cloud API only**. No unofficial libraries
  (whatsapp-web.js, Baileys, etc.).
- **Validation has two tiers:**
  - Tier A — **structural/format** validation via `libphonenumber-js` (free, instant).
  - Tier B — **deliverability**, which can only be confirmed by attempting a real send
    (the Cloud API has no standalone "check number" endpoint).
  - The UI must clearly label which tier produced each result.
- Outside the 24-hour customer-initiated window, **only pre-approved templates** can be
  sent. The default send path is templates; free-text is secondary, for active sessions.
- Bulk sends are **queued and rate-limited**, never a tight loop.
- Deployment target is **Hostinger** (Node app from a GitHub repo). **No guaranteed Redis** —
  the default queue is a DB-backed table with a `node-cron` polling worker. BullMQ+Redis
  is an optional path, not a hard dependency.
- Webhook must implement Meta's **GET verification handshake** (`hub.challenge`) and a
  **POST status handler**, reachable over HTTPS.

---

## Terminology

- **Session window** — the 24-hour window opened when a user messages the business first.
  Inside it, free-text messages are allowed. Outside it, only templates.
- **Template message** — a pre-approved message structure with a name, language, and
  optional variable components.
- **Bulk job** — a unit of work created from a CSV upload; contains many **bulk job items**,
  one per recipient.

---

## Functional Requirements

### Requirement 1 — Authentication

**User story:** As the admin, I want to log in with a username and password so that only I
can access validation and messaging features.

**Acceptance criteria:**
1. WHEN an unauthenticated user requests any protected route THEN the system SHALL redirect to `/login`.
2. WHEN the admin submits correct credentials THEN the system SHALL create a server-side session and redirect to the dashboard.
3. WHEN the admin submits incorrect credentials THEN the system SHALL re-render the login page with an error and SHALL NOT create a session.
4. WHEN the admin clicks logout THEN the system SHALL destroy the session and redirect to `/login`.
5. The system SHALL store the admin password as a hash (bcrypt), never plaintext.
6. The system SHALL protect state-changing routes against CSRF.

### Requirement 2 — Single number format validation (Tier A)

**User story:** As the admin, I want to validate a single phone number's format so that I
can catch malformed numbers before spending a send.

**Acceptance criteria:**
1. WHEN the admin submits a phone number (with optional default country) THEN the system SHALL parse it with `libphonenumber-js`.
2. WHEN the number is valid THEN the system SHALL return the E.164 form, country, and number type, labeled **"Format valid (Tier A — not a deliverability check)"**.
3. WHEN the number is invalid THEN the system SHALL return a clear reason (e.g. too short, invalid country code).
4. The system SHALL persist the result in `validation_results` with `check_type = 'format'`.
5. The system SHALL never claim a Tier A result confirms WhatsApp deliverability.

### Requirement 3 — Single number deliverability check (Tier B)

**User story:** As the admin, I want to check whether a number can actually receive
WhatsApp so that I know a number is reachable.

**Acceptance criteria:**
1. WHEN the admin requests a deliverability check THEN the system SHALL first perform Tier A; IF format is invalid THEN it SHALL stop and report the format error.
2. WHEN format is valid THEN the system SHALL attempt a real send via the Cloud API using a designated template (a probe template), because there is no standalone check endpoint.
3. WHEN the Cloud API accepts the message THEN the system SHALL record the result as **"Accepted for delivery (Tier B — pending webhook confirmation)"** with the returned `wamid`.
4. WHEN the Cloud API rejects the number THEN the system SHALL record `check_type = 'deliverability'` with status `failed` and the Meta error code/message.
5. The system SHALL make clear that final delivery status arrives asynchronously via webhook.
6. The UI SHALL warn that a deliverability check consumes a real message send (and may incur cost / affect quality rating).

### Requirement 4 — Bulk number validation (CSV upload)

**User story:** As the admin, I want to upload a CSV of phone numbers and get a validation
report so that I can clean a list efficiently.

**Acceptance criteria:**
1. WHEN the admin uploads a CSV THEN the system SHALL accept a configurable column (default `phone`) and an optional default country column/field.
2. The system SHALL run **Tier A format validation** on every row synchronously and produce a downloadable/renderable report (row, input, E.164, valid?, reason).
3. The system SHALL reject files over a configurable size limit and non-CSV MIME types with a clear error.
4. The system SHALL de-duplicate identical E.164 numbers in the report summary (count kept + count duplicate).
5. Tier B (deliverability) for bulk SHALL only be available through the bulk **send** flow (Requirement 6), not the validation flow, to avoid silent mass sends.
6. The system SHALL persist each row result in `validation_results` linked to an upload batch id.

### Requirement 5 — Send a single WhatsApp message

**User story:** As the admin, I want to send a WhatsApp message to one recipient using a
template (or free text within an open session) so that I can reach a contact.

**Acceptance criteria:**
1. The system SHALL default to **template** mode: admin selects a template name, language, and fills variables.
2. The system SHALL offer **free-text** mode, clearly labeled "only deliverable inside a 24-hour session window".
3. WHEN the admin submits THEN the system SHALL validate the recipient's format (Tier A) before calling Meta.
4. WHEN Meta accepts the message THEN the system SHALL persist a row in `messages` with the returned `wamid` and status `accepted`.
5. WHEN Meta returns an error THEN the system SHALL persist status `failed` with the error code/message and show it to the admin.
6. The system SHALL display the message and let the admin watch its status update as webhooks arrive.

### Requirement 6 — Send bulk WhatsApp messages (queued, rate-limited)

**User story:** As the admin, I want to upload a CSV and send a templated message to every
recipient through a queued, rate-limited job so that I don't trip Meta throttling.

**Acceptance criteria:**
1. WHEN the admin uploads a recipient CSV and chooses a template + variable mapping THEN the system SHALL create a `bulk_jobs` row and one `bulk_job_items` row per valid recipient.
2. The system SHALL run Tier A validation during import; invalid rows SHALL be recorded as `bulk_job_items` with status `skipped_invalid` and NOT sent.
3. The system SHALL process items via a **background worker**, sending one item at a time with a **configurable delay** between sends (rate limit).
4. The system SHALL NOT send bulk messages in a synchronous request/response loop.
5. WHEN an item send succeeds THEN the system SHALL store the `wamid` and set item status `sent`.
6. WHEN an item send fails THEN the system SHALL store the error and set item status `failed`, and SHALL continue with remaining items.
7. The system SHALL support a bounded **retry** (configurable max attempts) for transient failures (e.g. HTTP 429/5xx), with backoff.
8. The system SHALL update `bulk_jobs` aggregate counters (total, sent, failed, skipped) as items complete.
9. The worker SHALL be crash-safe: an interrupted job SHALL resume from pending items on restart (no double-send of already-sent items).

### Requirement 7 — Delivery status via webhook

**User story:** As the admin, I want per-message delivery status (sent / delivered / read /
failed) so that I can confirm outcomes.

**Acceptance criteria:**
1. WHEN Meta sends a `GET` verification request THEN the system SHALL echo `hub.challenge` IFF `hub.verify_token` matches the configured token, else respond 403.
2. WHEN Meta sends a `POST` status callback THEN the system SHALL verify the payload signature (`X-Hub-Signature-256`) against the app secret before processing.
3. WHEN a valid status callback arrives THEN the system SHALL locate the message by `wamid` and update its status to `sent`/`delivered`/`read`/`failed` with a timestamp.
4. WHEN a `failed` status arrives THEN the system SHALL store the error code, title, and details.
5. The webhook handler SHALL respond `200` quickly and SHALL be idempotent (repeated callbacks SHALL NOT corrupt state or regress a later status to an earlier one).
6. The system SHALL log unmatched `wamid`s rather than failing the request.

### Requirement 8 — Bulk job history & progress

**User story:** As the admin, I want to see job history and live progress so that I know how
a bulk send is going and why items failed.

**Acceptance criteria:**
1. The system SHALL list all bulk jobs with created time, template, status, and X-of-Y progress.
2. WHEN the admin opens a job THEN the system SHALL show per-item status, recipient, `wamid`, and failure reason where applicable.
3. The system SHALL show a live-updating progress indicator (polling is acceptable for MVP).
4. The system SHALL let the admin filter items by status (sent/failed/skipped/pending).
5. The system SHALL allow re-queueing failed items of a completed job (optional stretch, gated behind a button).

---

## Non-Functional Requirements

### NFR-1 Rate limiting & throttling safety
- Bulk sends SHALL respect a configurable inter-send delay (env `SEND_DELAY_MS`, default e.g. 1000ms) and a max messages-per-run cap for the worker tick.
- On HTTP 429 or Meta rate-limit error codes, the worker SHALL back off exponentially and SHALL NOT hammer the API.

### NFR-2 Error handling
- All external API calls SHALL have timeouts and SHALL translate Meta error payloads into stored, human-readable reasons.
- No unhandled promise rejection SHALL crash the worker; item-level failures SHALL be isolated.
- User-facing errors SHALL never leak stack traces or credentials.

### NFR-3 Webhook reliability
- The webhook SHALL verify signatures, be idempotent, respond within Meta's timeout, and tolerate out-of-order/duplicate callbacks.
- Status transitions SHALL be monotonic where meaningful (a `read` SHALL NOT be overwritten by a late `delivered`).

### NFR-4 Credential security
- All secrets (Meta token, app secret, phone number id, verify token, DB creds, session secret) SHALL come from environment variables, never committed.
- A `.env.example` SHALL document required variables without real values.
- Access token and app secret SHALL never be rendered in views or logs.

### NFR-5 Data & schema
- Minimum tables: `admins`, `contacts`, `validation_results`, `messages`, `bulk_jobs`, `bulk_job_items`, plus a `webhook_events` audit table.
- All timestamps SHALL be stored in UTC.

### NFR-6 Deployability (Hostinger)
- App SHALL start from `npm start` and read config from env.
- Queue SHALL work with **no Redis** (DB-backed + node-cron) by default; Redis/BullMQ SHALL be opt-in via env flag.
- A DB migration/seed step SHALL be runnable via `npm run migrate` (and seed the admin user).

### NFR-7 Observability
- The app SHALL log structured events for sends, webhook receipts, and worker ticks.
- Bulk job counters SHALL be queryable to reconstruct progress after a restart.
