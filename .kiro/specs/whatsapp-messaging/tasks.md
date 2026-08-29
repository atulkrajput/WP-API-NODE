# Implementation Plan — WhatsApp Validation & Messaging MVP

Each task is independently testable. Complete in order.

- [x] 1. Project scaffold & configuration
  - Init npm, install deps (express, ejs, mysql2, express-session, bcryptjs, axios,
    libphonenumber-js, multer, csv-parse, node-cron, dotenv, cookie-parser, helmet, morgan).
  - Create `src/config/index.js` reading all env vars with sane defaults; add `.env.example`.
  - Create `src/app.js`, `src/server.js`, `/health` route, and `npm start`/`npm run dev` scripts.
  - _Test:_ `npm start` boots, `GET /health` returns 200 JSON.
  - _Requirements: NFR-4, NFR-6_

- [x] 2. MySQL connection, migrations & seed
  - `src/db/pool.js` (mysql2 promise pool), `src/db/migrate.js` runner, migration SQL for all
    tables from design §3, `src/db/seed.js` to create the admin (bcrypt hash from env).
  - Scripts: `npm run migrate`, `npm run seed`.
  - _Test:_ run migrate+seed against a local/dev MySQL; tables exist; one admin row present.
  - _Requirements: 1, NFR-5_

- [x] 3. Authentication & session
  - `express-session`, login page/controller, bcrypt verify, `requireAuth` middleware,
    logout, CSRF middleware, helmet.
  - _Test:_ wrong creds rejected; correct creds set session and reach `/`; protected route
    redirects when logged out; logout clears session.
  - _Requirements: 1_

- [x] 4. PhoneService + single format validation (Tier A)
  - `phoneService.parse(input, defaultCountry)` → {valid, e164, country, type, reason}.
  - `POST /validate/single` persists to `validation_results` (check_type=format) and returns
    JSON labeled Tier A.
  - _Test:_ valid US/intl numbers return E.164; malformed returns reason; row persisted.
  - _Requirements: 2_

- [x] 5. WhatsAppService (Meta Cloud API wrapper)
  - axios instance (base URL, bearer, timeout); `sendTemplate(to, name, lang, components)`
    and `sendText(to, body)`; normalize success (`wamid`) and error (`{code,title,detail}`).
  - _Test:_ unit test with mocked axios for success + error payload normalization.
  - _Requirements: 5, 3_

- [x] 6. Single message send
  - `GET /messages` page (template/text toggle, variables); `POST /messages/single` →
    Tier A check → WhatsAppService → persist `messages` row; `GET /messages/:id/status` JSON.
  - _Test:_ template send stores `wamid`+accepted (mocked); error path stores failed;
    status endpoint returns current state.
  - _Requirements: 5_

- [x] 7. Deliverability check (Tier B)
  - `POST /validate/deliverability`: Tier A first, then probe send via WhatsAppService using
    PROBE_TEMPLATE; persist `validation_results` (deliverability) with wamid/failed; UI warns
    it consumes a send.
  - _Test:_ valid number → accepted+wamid (mocked); invalid format short-circuits; Meta reject
    stores failure.
  - _Requirements: 3_

- [x] 8. Webhook verification + status handler
  - Raw-body middleware for `/webhook`; `GET` handshake (hub.challenge/verify token);
    `POST` signature verify (`X-Hub-Signature-256`), dedupe via `webhook_events`, match by
    `wamid`, monotonic status update + timestamps/errors; respond 200 fast.
  - _Test:_ GET returns challenge with right token / 403 with wrong; POST with valid signature
    updates message status; duplicate callback is idempotent; late `delivered` doesn't regress `read`.
  - _Requirements: 7, NFR-3_

- [x] 9. Bulk number validation (CSV, Tier A)
  - `POST /validate/bulk` with multer + csv-parse; per-row Tier A; dedupe summary; persist rows
    with a batch_id; render/downloadable report; size + MIME guards.
  - _Test:_ upload a sample CSV → report with valid/invalid/duplicate counts; oversized/non-CSV rejected.
  - _Requirements: 4_

- [x] 10. Bulk send job creation (CSV → queue)
  - `GET /bulk` list + create form (template, language, variable mapping); `POST /bulk` parses
    CSV, Tier A per row, creates `bulk_jobs` + `bulk_job_items` (invalid rows → skipped_invalid),
    sets job running.
  - _Test:_ upload → job row + N item rows with correct statuses/counters; invalid rows skipped.
  - _Requirements: 6 (1,2)_

- [x] 11. Background worker + rate limiting + retries
  - `node-cron` tick with in-process lock; atomic claim of pending items; `SEND_DELAY_MS`
    between sends; success→messages row+wamid+counters; transient failure→backoff retry;
    permanent/exhausted→failed; job completion detection; startup reconciler for stuck
    `processing` items (guarded by existing wamid to avoid double-send).
  - _Test:_ create job with mocked service, run tick(s), verify items progress, delay honored,
    429 triggers retry/backoff, counters correct, restart reconciles.
  - _Requirements: 6 (3-9), NFR-1, NFR-2, NFR-7_

- [x] 12. Bulk job history & progress UI
  - `GET /bulk/:id` detail with per-item status/wamid/reason + status filter; `GET /bulk/:id/progress`
    JSON; client polling for live X-of-Y; job list progress bars.
  - _Test:_ detail shows items, filter works, progress endpoint reflects live counts.
  - _Requirements: 8_

- [x] 13. Dashboard views polish + wiring
  - Dashboard summary (recent validations, recent messages, active jobs), Bootstrap layout,
    Tier A/B labels prominent, template-vs-freetext guidance, error/flash messaging.
  - _Test:_ navigate all pages logged in; labels present; flash errors render.
  - _Requirements: 2,3,5, NFR-2_

- [x] 14. Hardening & deploy prep (Hostinger)
  - Confirm env-only secrets, no secret logging, HTTPS-aware cookies, `QUEUE_DRIVER=db` default,
    README run/deploy notes, `npm run migrate`+`seed` documented, graceful worker start in `server.js`.
  - _Test:_ fresh clone + env + migrate + seed + start works; webhook reachable over HTTPS in staging.
  - _Requirements: NFR-4, NFR-6, 7_

- [x] 15. (Optional stretch) Retry-failed & BullMQ path
  - `POST /bulk/:id/retry-failed` re-queues failed items; `QUEUE_DRIVER=bullmq` adapter behind
    same service contract.
  - _Test:_ failed items re-queue and process; bullmq path processes when Redis present.
  - _Requirements: 8(5), NFR-6_
