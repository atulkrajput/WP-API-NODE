# Architecture Review — WhatsApp Hub

_Date: 2026-10-25_

## TL;DR

- The app was a solid **single-admin tool** (validate, send, bulk send, delivery
  tracking via webhook). It was **not reusable by other projects** — no API.
- **Shipped in this change:** REST API v1 with per-project API keys, a fix for
  a production bug that broke all page JavaScript, a redesigned UI, and a
  go-live checklist on the dashboard.
- **Number strategy:** get a **new dedicated number** for the API. Keep your
  current WhatsApp Business number for human chat. Your existing Facebook
  Business verification covers the new number.

## What was broken

| Issue | Impact | Status |
|---|---|---|
| Helmet's default CSP (`script-src 'self'`) blocked every inline `<script>` and the Bootstrap JS CDN | In a real browser, Send message, Validate, Bulk upload, and live progress pages did nothing. Tests passed because they don't run a browser. | **Fixed** — per-request CSP nonce |
| `SESSION_SECRET` silently fell back to `change-me-in-env` | Guessable session cookies in prod if the env var is missed | **Fixed** — app refuses to start in production |
| No machine API | Other projects couldn't use the number | **Fixed** — `/api/v1` |

## How projects use it now

```
 Project A ─┐                              ┌─> Meta Cloud API ─> WhatsApp user
 Project B ─┼─ Bearer key ─> /api/v1 ──────┤
 Admin UI  ─┘   (per-key rate limit)       └─< /webhook (status updates)
                     │
                     └─ MySQL: messages tagged with api_client_id + reference
```

- One verified sender number, many projects. Each key is hashed at rest,
  revocable, rate-limited, and scoped (a project only sees its own messages).
- `reference` lets a project pass its own id (order id, ticket id) and find it
  later.

## Which number to use

Your Facebook Business (business portfolio) is already verified. That
verification is at the **business level**, so any number you add to the same
WhatsApp Business Account inherits it. Each new number still needs its
**display name** approved (usually quick).

| Option | Pros | Cons |
|---|---|---|
| **A. New dedicated API number (recommended)** | Full Cloud API throughput and features. Bulk/marketing sends can't damage the quality rating of your main customer line. Clean separation: humans chat on the old number, systems send from the new one. | Customers see a second number. Need a SIM/landline that can receive one OTP (SMS or voice) and is not registered on WhatsApp. |
| B. Move current Business App number to the API ("coexistence") | Customers keep one familiar number; Meta lets you keep using the Business App on it. | Lower throughput and some app features are limited. Availability depends on country — check during Meta's onboarding flow. A spam spike from bulk sends hits your main brand number. |
| C. Move current number to API only (delete from the app) | One number, full API. | You lose the Business App on that number. Hard to undo. |

**Recommendation: A.** Buy a new number, add it under the same WABA in Meta
Business Manager, verify by OTP, get the display name approved, then put its
**Phone number ID** into `PHONE_NUMBER_ID`.

Things that apply regardless:

- **Messaging limits** start low (business-initiated messages to ~250 unique
  users / 24h) and rise automatically with good quality and volume. Bulk sends
  above the limit fail with an error code — the worker records it.
- **Pricing:** Meta charges per delivered **template** message (marketing,
  utility, authentication rates differ by country). Replies inside the 24-hour
  customer window are free. The **Tier B probe sends a real template**, so every
  deliverability check is billed and messages a real person — use it
  sparingly.
- Use a **System User permanent token**, never the 24-hour temporary token.

## Go-live runbook (P0)

1. Get the number (Option A) and add it to the WABA.
2. Create and submit **utility** templates you need (order update, OTP, reminder). Wait for approval.
3. Set env vars on Hostinger: `WHATSAPP_TOKEN` (System User), `PHONE_NUMBER_ID`,
   `WABA_ID`, `APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `SESSION_SECRET`,
   `NODE_ENV=production`.
4. `npm run migrate` (applies migration 002).
5. In Meta → WhatsApp → Configuration: callback `https://YOUR_DOMAIN/webhook`,
   your verify token, subscribe to **messages**.
6. Dashboard → go-live checklist should be all green.
7. Settings → API keys → create one key per project.
8. Smoke test: `POST /api/v1/messages` with `hello_world` to your own phone,
   then `GET /api/v1/messages/:id` until `delivered`.

## Roadmap

**P1 — makes it a real shared service**

- ✅ **Status callbacks to projects** (shipped). Per-key callback URL, signed
  `message.status` / `message.received` events, outbox with retries.
- ✅ **Inbound messages** (shipped). Stored, routed to the right project, 24h
  window tracking, STOP/START opt-out, Inbox with replies.
- **Inbound media download.** Media messages store Meta's media id only; add a
  proxy endpoint that fetches the file with the access token.
- **Template sync.** Pull approved templates from the WABA
  (`GET /{WABA_ID}/message_templates`) into a dropdown + validate variable
  count before sending.
- **Bulk via API.** `POST /api/v1/bulk` with a JSON recipient list, reusing the
  existing queue/worker.

**P2 — scale**

- **Multiple sender numbers.** Store `phone_number_id` + token per sender; map
  each API key to a sender. Needed once you run several brands.
- Per-project daily quotas and cost estimates.
- Move the rate limiter and queue to Redis (`QUEUE_DRIVER=bullmq` already
  exists) if you run more than one Node process.
- Request ids + structured logs shipped to a log service.
