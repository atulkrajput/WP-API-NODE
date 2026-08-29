'use strict';

/**
 * Webhook verification + status handler tests — Requirement 7, NFR-3 (Task 8).
 *
 * The DB-backed models (`message`, `webhookEvent`) are mocked so these run with
 * no live MySQL. `webhookEvent.buildEventHash` is the REAL implementation (it is
 * a pure crypto helper) so dedupe keys are genuine. `message.advanceStatus` is
 * the REAL monotonic implementation running against an in-memory fake row so the
 * "late delivered doesn't regress read" and idempotency behaviours are exercised
 * for real rather than asserted against a stub.
 *
 * Coverage:
 *   - GET returns the challenge with the right verify token (Req 7.1)
 *   - GET returns 403 with the wrong token (Req 7.1)
 *   - POST with a valid signature updates the message status (Req 7.2, 7.3)
 *   - POST with an invalid signature → 401, nothing processed (Req 7.2)
 *   - duplicate callback is idempotent (Req 7.5)
 *   - late `delivered` does not regress `read` (NFR-3)
 *   - `failed` stores error code/title/detail (Req 7.4)
 *   - unmatched wamid is logged and still returns 200 (Req 7.6)
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_SECRET = 'test-app-secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify-me-123';

const crypto = require('crypto');
const request = require('supertest');

// Mock only the DB-backed models. The message model keeps its REAL monotonic
// logic but its pool access is replaced by an in-memory fake below.
jest.mock('../src/db/pool', () => ({
  execute: jest.fn(),
  query: jest.fn(),
}));
jest.mock('../src/models/webhookEvent');

const webhookEventModel = require('../src/models/webhookEvent');
// Use the real buildEventHash (pure helper) even though the module is mocked.
const realBuildEventHash = jest.requireActual(
  '../src/models/webhookEvent'
).buildEventHash;

const pool = require('../src/db/pool');
const messageModel = require('../src/models/message');
const createApp = require('../src/app');

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'verify-me-123';

/** Compute a valid Meta signature header for a raw JSON string. */
function sign(rawBody) {
  return (
    'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(rawBody)).digest('hex')
  );
}

/** Build a Meta status callback payload (design §5.5). */
function statusPayload(statusObj) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { field: 'messages', value: { statuses: [statusObj] } },
        ],
      },
    ],
  };
}

// ---- In-memory message store backing the REAL advanceStatus logic ----
let messageStore;

function seedMessage(row) {
  messageStore.set(row.wamid, { ...row });
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  messageStore = new Map();

  // Real dedupe hashing.
  webhookEventModel.buildEventHash.mockImplementation(realBuildEventHash);

  // webhook_events insert: dedupe against an in-memory set of hashes.
  const seenHashes = new Set();
  let nextEventId = 1;
  webhookEventModel.insert.mockImplementation(async ({ eventHash }) => {
    if (seenHashes.has(eventHash)) {
      return { inserted: false, id: null, duplicate: true };
    }
    seenHashes.add(eventHash);
    return { inserted: true, id: nextEventId++, duplicate: false };
  });
  webhookEventModel.markProcessed.mockResolvedValue(undefined);

  // Back the REAL message-model logic with an in-memory store by implementing
  // the mocked pool's `execute`. advanceStatus issues:
  //   - SELECT ... WHERE wamid = ?  (via findByWamid)
  //   - UPDATE messages SET status='failed' ... WHERE wamid=? AND status<>'read' AND status<>'failed'
  //   - UPDATE messages SET status=?, <col>=COALESCE(...) WHERE wamid=? AND status IN (...)
  // We interpret those against messageStore, preserving the monotonic guards.
  pool.execute.mockImplementation(async (sql, params) => {
    const text = String(sql);

    if (/^\s*SELECT/i.test(text)) {
      const wamid = params[params.length - 1];
      const row = messageStore.get(wamid);
      return [row ? [{ ...row }] : []];
    }

    if (/UPDATE messages\s+SET status = 'failed'/i.test(text)) {
      const [errorCode, errorTitle, errorDetail, ts, wamid] = params;
      const row = messageStore.get(wamid);
      if (!row || row.status === 'read' || row.status === 'failed') {
        return [{ affectedRows: 0 }];
      }
      row.status = 'failed';
      row.error_code = errorCode;
      row.error_title = errorTitle;
      row.error_detail = errorDetail;
      row.failed_at = row.failed_at || ts;
      return [{ affectedRows: 1 }];
    }

    if (/UPDATE messages\s+SET status = \?/i.test(text)) {
      // params: [status, ts, wamid, ...lowerStatuses]
      const [status, ts, wamid, ...lowerStatuses] = params;
      const row = messageStore.get(wamid);
      if (!row || !lowerStatuses.includes(row.status)) {
        return [{ affectedRows: 0 }];
      }
      row.status = status;
      const col = {
        sent: 'sent_at',
        delivered: 'delivered_at',
        read: 'read_at',
        accepted: 'accepted_at',
      }[status];
      if (col) row[col] = row[col] || ts;
      return [{ affectedRows: 1 }];
    }

    return [{ affectedRows: 0 }];
  });

  app = createApp();
});

// -------------------- GET /webhook (Req 7.1) --------------------

describe('GET /webhook — verification handshake (Requirement 7.1)', () => {
  test('echoes hub.challenge when the verify token matches', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '1234567890',
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe('1234567890');
  });

  test('returns 403 when the verify token is wrong', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'WRONG',
      'hub.challenge': '1234567890',
    });

    expect(res.status).toBe(403);
    expect(res.text).not.toBe('1234567890');
  });
});

// -------------------- POST /webhook signature (Req 7.2) --------------------

describe('POST /webhook — signature verification (Requirement 7.2)', () => {
  test('rejects an invalid signature with 401 and processes nothing', async () => {
    const advanceSpy = jest.spyOn(messageModel, 'advanceStatus');
    const payload = statusPayload({
      id: 'wamid.ABC',
      status: 'delivered',
      timestamp: '1730000000',
    });
    const raw = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send(raw);

    expect(res.status).toBe(401);
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(webhookEventModel.insert).not.toHaveBeenCalled();
  });

  test('accepts a valid signature and updates the message status', async () => {
    seedMessage({ id: 10, wamid: 'wamid.ABC', status: 'accepted' });

    const payload = statusPayload({
      id: 'wamid.ABC',
      status: 'delivered',
      timestamp: '1730000000',
    });
    const raw = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    expect(messageStore.get('wamid.ABC').status).toBe('delivered');
    expect(messageStore.get('wamid.ABC').delivered_at).toBeTruthy();
  });
});

// -------------------- idempotency (Req 7.5) --------------------

describe('POST /webhook — idempotent duplicate callbacks (Requirement 7.5)', () => {
  test('a repeated identical callback does not re-process', async () => {
    seedMessage({ id: 11, wamid: 'wamid.DUP', status: 'accepted' });

    const payload = statusPayload({
      id: 'wamid.DUP',
      status: 'sent',
      timestamp: '1730000100',
    });
    const raw = JSON.stringify(payload);
    const sig = sign(raw);

    const advanceSpy = jest.spyOn(messageModel, 'advanceStatus');

    const first = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .send(raw);
    const second = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .send(raw);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // advanceStatus runs on the first (non-duplicate) event only.
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(messageStore.get('wamid.DUP').status).toBe('sent');
  });
});

// -------------------- monotonicity (NFR-3) --------------------

describe('POST /webhook — monotonic status (NFR-3)', () => {
  test('a late `delivered` does not regress a message already `read`', async () => {
    seedMessage({
      id: 12,
      wamid: 'wamid.READ',
      status: 'read',
      read_at: '2024-01-01 00:00:10',
    });

    const payload = statusPayload({
      id: 'wamid.READ',
      status: 'delivered',
      timestamp: '1730000200',
    });
    const raw = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    // Still read — never regressed.
    expect(messageStore.get('wamid.READ').status).toBe('read');
  });

  test('forward transitions advance normally (sent → delivered → read)', async () => {
    seedMessage({ id: 13, wamid: 'wamid.SEQ', status: 'accepted' });

    for (const [status, ts] of [
      ['sent', '1730000000'],
      ['delivered', '1730000001'],
      ['read', '1730000002'],
    ]) {
      const payload = statusPayload({ id: 'wamid.SEQ', status, timestamp: ts });
      const raw = JSON.stringify(payload);
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(raw))
        .send(raw);
      expect(res.status).toBe(200);
    }

    expect(messageStore.get('wamid.SEQ').status).toBe('read');
  });
});

// -------------------- failed status stores error (Req 7.4) --------------------

describe('POST /webhook — failed status stores error info (Requirement 7.4)', () => {
  test('stores error code, title, and detail on failed', async () => {
    seedMessage({ id: 14, wamid: 'wamid.FAIL', status: 'sent' });

    const payload = statusPayload({
      id: 'wamid.FAIL',
      status: 'failed',
      timestamp: '1730000300',
      errors: [
        {
          code: 131026,
          title: 'Message undeliverable',
          error_data: { details: 'Receiver incapable' },
        },
      ],
    });
    const raw = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    const row = messageStore.get('wamid.FAIL');
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('131026');
    expect(row.error_title).toBe('Message undeliverable');
    expect(row.error_detail).toBe('Receiver incapable');
  });

  test('a late `failed` does not overwrite a `read` message', async () => {
    seedMessage({ id: 15, wamid: 'wamid.RF', status: 'read' });

    const payload = statusPayload({
      id: 'wamid.RF',
      status: 'failed',
      timestamp: '1730000400',
      errors: [{ code: 1, title: 't' }],
    });
    const raw = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    expect(messageStore.get('wamid.RF').status).toBe('read');
  });
});

// -------------------- unmatched wamid (Req 7.6) --------------------

describe('POST /webhook — unmatched wamid (Requirement 7.6)', () => {
  test('logs and still returns 200 when no message matches', async () => {
    const payload = statusPayload({
      id: 'wamid.UNKNOWN',
      status: 'delivered',
      timestamp: '1730000500',
    });
    const raw = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    // No row to update.
    expect(messageStore.has('wamid.UNKNOWN')).toBe(false);
  });
});
