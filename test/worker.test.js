'use strict';

/**
 * Background worker tests — Requirement 6 (3-9), NFR-1/2/7 (Task 11).
 *
 * The worker's `tick()` / `reconcile()` are exercised with fully injected
 * dependencies: an in-memory fake of the bulkJobItem "queue" and bulkJob store,
 * a mocked WhatsAppService, a mocked message model, a fake delay (so no real
 * timers run), and a controllable clock. No live MySQL, no network, no cron.
 *
 * Covered:
 *   - items progress pending → sent, messages rows created, sent_count bumped;
 *   - SEND_DELAY_MS honored BETWEEN sends (delay call count + args);
 *   - transient 429 → requeued with attempts++ and a future next_attempt_at;
 *   - transient with attempts exhausted → failed + failed_count bump;
 *   - permanent error → failed immediately (no retry);
 *   - job completion → status set to completed when nothing outstanding;
 *   - item-level error isolation (a thrown send doesn't crash the tick);
 *   - overlap lock skips a re-entrant tick;
 *   - reconciler resets stuck processing (wamid IS NULL) but leaves sent ones;
 *   - transient classification + backoff helpers.
 */

process.env.NODE_ENV = 'test';

const worker = require('../src/worker/worker');

// -------------------- in-memory fakes --------------------

/**
 * Build an in-memory bulkJobItem model fake backed by a plain array. Mirrors the
 * real model's worker methods (claimPending, markSent, markFailed, requeue,
 * resetStuckProcessing, countOutstanding).
 *
 * Rows are `{ id, job_id, to_e164, raw_input, variables, status, attempts,
 * wamid, error_detail, next_attempt_at, updated_at }`.
 */
function makeItemStore(rows) {
  const store = { rows: rows.map((r) => ({ ...r })) };

  const asMs = (dt) => (dt ? new Date(dt.replace(' ', 'T') + 'Z').getTime() : 0);

  return {
    store,
    claimPending: jest.fn(async (limit) => {
      // NULL next_attempt_at is "due now".
      const nowMs = Date.now();
      const due = store.rows
        .filter(
          (r) =>
            r.status === 'pending' &&
            (r.next_attempt_at == null || asMs(r.next_attempt_at) <= nowMs)
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      due.forEach((r) => {
        r.status = 'processing';
      });
      // Return copies so the worker mutating job rows doesn't touch the store
      // through references (the real model returns fresh rows).
      return due.map((r) => ({ ...r }));
    }),
    markSent: jest.fn(async (id, wamid) => {
      const r = store.rows.find((x) => x.id === id);
      if (!r) return false;
      r.status = 'sent';
      r.wamid = wamid;
      r.error_detail = null;
      return true;
    }),
    markFailed: jest.fn(async (id, error) => {
      const r = store.rows.find((x) => x.id === id);
      if (!r) return false;
      r.status = 'failed';
      r.error_detail = error;
      return true;
    }),
    requeue: jest.fn(async (id, attempts, nextAttemptAt, error) => {
      const r = store.rows.find((x) => x.id === id);
      if (!r) return false;
      r.status = 'pending';
      r.attempts = attempts;
      r.next_attempt_at = nextAttemptAt;
      r.error_detail = error;
      return true;
    }),
    resetStuckProcessing: jest.fn(async (olderThan) => {
      let n = 0;
      store.rows.forEach((r) => {
        if (
          r.status === 'processing' &&
          r.wamid == null &&
          asMs(r.updated_at) <= asMs(olderThan)
        ) {
          r.status = 'pending';
          r.next_attempt_at = null;
          n += 1;
        }
      });
      return n;
    }),
    countOutstanding: jest.fn(async (jobId) =>
      store.rows.filter(
        (r) =>
          r.job_id === jobId &&
          (r.status === 'pending' || r.status === 'processing')
      ).length
    ),
  };
}

/** Build an in-memory bulkJob model fake. */
function makeJobStore(jobs) {
  const store = { jobs: jobs.map((j) => ({ ...j })) };
  return {
    store,
    getById: jest.fn(async (id) => {
      const j = store.jobs.find((x) => x.id === id);
      return j ? { ...j } : null;
    }),
    updateStatus: jest.fn(async (id, status) => {
      const j = store.jobs.find((x) => x.id === id);
      if (!j) return false;
      j.status = status;
      return true;
    }),
    updateCounters: jest.fn(async (id, counters) => {
      const j = store.jobs.find((x) => x.id === id);
      if (!j) return false;
      if (counters.sentCount !== undefined) j.sent_count = counters.sentCount;
      if (counters.failedCount !== undefined) j.failed_count = counters.failedCount;
      if (counters.skippedCount !== undefined) j.skipped_count = counters.skippedCount;
      if (counters.totalCount !== undefined) j.total_count = counters.totalCount;
      return true;
    }),
  };
}

/** A silent logger so tests don't spam stdout. */
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Config used across tests. */
const cfg = {
  worker: { sendDelayMs: 1000, intervalSec: 5, batch: 5, maxAttempts: 3 },
  queue: { driver: 'db' },
};

// -------------------- pure helpers --------------------

describe('transient classification (Req 6.7, NFR-1)', () => {
  test.each([
    ['429', true],
    [429, true],
    ['500', true],
    ['503', true],
    ['ETIMEDOUT', true],
    ['ECONNREFUSED', true],
    ['ECONNRESET', true],
    [130429, true], // Meta rate-limit code
    [131048, true], // spam rate limit
  ])('code %s → transient=%s', (code, expected) => {
    expect(worker.isTransient({ code })).toBe(expected);
  });

  test.each([
    ['132001', false], // template does not exist (permanent)
    [131047, false], // outside 24h window (permanent for a template? treat permanent)
    ['100', false], // invalid parameter
    [null, false],
  ])('code %s → transient=%s (permanent)', (code, expected) => {
    expect(worker.isTransient({ code })).toBe(expected);
  });

  test('textual rate-limit hint is transient even without a known code', () => {
    expect(worker.isTransient({ code: '99999', title: 'Rate limit hit' })).toBe(true);
    expect(worker.isTransient({ code: null, detail: 'Too many requests' })).toBe(true);
  });
});

describe('backoff (NFR-1)', () => {
  test('exponential growth base * 2^(attempts-1)', () => {
    expect(worker.backoffMs(1, 1000)).toBe(1000);
    expect(worker.backoffMs(2, 1000)).toBe(2000);
    expect(worker.backoffMs(3, 1000)).toBe(4000);
  });
  test('capped at the cap', () => {
    expect(worker.backoffMs(20, 1000, 5000)).toBe(5000);
  });
});

describe('buildComponents from item.variables (design §5.1)', () => {
  test('position map → ordered body parameters', () => {
    expect(worker.buildComponents({ 2: 'NYC', 1: 'Alice' })).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Alice' },
          { type: 'text', text: 'NYC' },
        ],
      },
    ]);
  });
  test('array form works', () => {
    expect(worker.buildComponents(['A', 'B'])).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
    ]);
  });
  test('empty/blank → no components', () => {
    expect(worker.buildComponents(null)).toEqual([]);
    expect(worker.buildComponents({ 1: '', 2: '   ' })).toEqual([]);
  });
});

// -------------------- tick: happy path --------------------

describe('tick — success path (Req 6.5, 6.8, NFR-1)', () => {
  test('items go pending → sent, messages rows inserted, sent_count bumped, delay honored', async () => {
    const items = makeItemStore([
      { id: 1, job_id: 10, to_e164: '+12025550182', raw_input: '+12025550182', variables: { 1: 'Alice' }, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
      { id: 2, job_id: 10, to_e164: '+442071838750', raw_input: '+442071838750', variables: { 1: 'Bob' }, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ]);
    const jobs = makeJobStore([
      { id: 10, template_name: 'promo', language: 'en_US', msg_type: 'template', status: 'running', sent_count: 0, failed_count: 0 },
    ]);
    const message = { insert: jest.fn(async () => 1) };
    const whatsappService = {
      sendTemplate: jest.fn(async () => ({ ok: true, wamid: 'wamid.OK' })),
      sendText: jest.fn(),
    };
    const delay = jest.fn(async () => {});

    const w = worker.createWorker({
      config: cfg,
      whatsappService,
      bulkJob: jobs,
      bulkJobItem: items,
      message,
      delay,
      logger: silentLogger,
    });

    const summary = await w.tick();

    expect(summary).toMatchObject({ claimed: 2, sent: 2, requeued: 0, failed: 0 });

    // Both items sent with wamid.
    expect(items.store.rows.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(items.store.rows.every((r) => r.wamid === 'wamid.OK')).toBe(true);
    expect(items.markSent).toHaveBeenCalledTimes(2);

    // A messages row per sent item, linked back and accepted.
    expect(message.insert).toHaveBeenCalledTimes(2);
    const firstMsg = message.insert.mock.calls[0][0];
    expect(firstMsg).toMatchObject({
      wamid: 'wamid.OK',
      status: 'accepted',
      msgType: 'template',
      templateName: 'promo',
      language: 'en_US',
      bulkJobItemId: 1,
    });

    // Template components built from variables.
    const call = whatsappService.sendTemplate.mock.calls[0];
    expect(call[1]).toBe('promo');
    expect(call[2]).toBe('en_US');
    expect(call[3]).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Alice' }] },
    ]);

    // sent_count bumped to 2 (Req 6.8).
    expect(jobs.store.jobs[0].sent_count).toBe(2);

    // Rate limit: delay called BETWEEN sends → once for 2 items, with SEND_DELAY_MS.
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(1000);

    // Job completed once no outstanding items remain (Req 6.8).
    expect(jobs.store.jobs[0].status).toBe('completed');
    expect(jobs.updateStatus).toHaveBeenCalledWith(10, 'completed');
  });
});

// -------------------- tick: transient retry / backoff --------------------

describe('tick — transient 429 retry with backoff (Req 6.7, NFR-1)', () => {
  test('429 requeues with attempts++ and a future next_attempt_at; job NOT completed', async () => {
    const items = makeItemStore([
      { id: 1, job_id: 10, to_e164: '+12025550182', raw_input: 'x', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ]);
    const jobs = makeJobStore([
      { id: 10, template_name: 'promo', language: 'en_US', msg_type: 'template', status: 'running', sent_count: 0, failed_count: 0 },
    ]);
    const message = { insert: jest.fn() };
    const whatsappService = {
      sendTemplate: jest.fn(async () => ({ ok: false, code: 429, title: 'Too Many Requests', detail: 'slow down' })),
      sendText: jest.fn(),
    };
    const fixedNow = Date.parse('2024-06-01T00:00:00Z');

    const w = worker.createWorker({
      config: cfg,
      whatsappService,
      bulkJob: jobs,
      bulkJobItem: items,
      message,
      delay: jest.fn(async () => {}),
      now: () => fixedNow,
      logger: silentLogger,
    });

    const summary = await w.tick();

    expect(summary).toMatchObject({ claimed: 1, sent: 0, requeued: 1, failed: 0 });

    const row = items.store.rows[0];
    expect(row.status).toBe('pending'); // back to pending for retry
    expect(row.attempts).toBe(1); // incremented
    expect(items.requeue).toHaveBeenCalledTimes(1);

    // next_attempt_at is in the FUTURE relative to now (backoff = 1000ms for attempt 1).
    const nextMs = new Date(row.next_attempt_at.replace(' ', 'T') + 'Z').getTime();
    expect(nextMs).toBeGreaterThan(fixedNow);
    expect(nextMs).toBe(fixedNow + 1000);

    // No messages row, no sent_count bump.
    expect(message.insert).not.toHaveBeenCalled();
    expect(jobs.store.jobs[0].sent_count).toBe(0);

    // Job still has an outstanding (pending) item → NOT completed.
    expect(jobs.store.jobs[0].status).toBe('running');
  });

  test('transient failure with attempts already at max-1 → exhausted → failed', async () => {
    // maxAttempts = 3; item already has attempts=2, so this failure makes 3 → exhausted.
    const items = makeItemStore([
      { id: 1, job_id: 10, to_e164: '+12025550182', raw_input: 'x', variables: null, status: 'pending', attempts: 2, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ]);
    const jobs = makeJobStore([
      { id: 10, template_name: 'promo', language: 'en_US', msg_type: 'template', status: 'running', sent_count: 0, failed_count: 0 },
    ]);
    const whatsappService = {
      sendTemplate: jest.fn(async () => ({ ok: false, code: 503, title: 'Service Unavailable', detail: 'try later' })),
      sendText: jest.fn(),
    };

    const w = worker.createWorker({
      config: cfg,
      whatsappService,
      bulkJob: jobs,
      bulkJobItem: items,
      message: { insert: jest.fn() },
      delay: jest.fn(async () => {}),
      logger: silentLogger,
    });

    const summary = await w.tick();

    expect(summary).toMatchObject({ claimed: 1, sent: 0, requeued: 0, failed: 1 });
    expect(items.store.rows[0].status).toBe('failed');
    expect(items.requeue).not.toHaveBeenCalled();
    expect(items.markFailed).toHaveBeenCalledTimes(1);
    expect(jobs.store.jobs[0].failed_count).toBe(1); // Req 6.8
    // No outstanding items → completed.
    expect(jobs.store.jobs[0].status).toBe('completed');
  });
});

// -------------------- tick: permanent failure --------------------

describe('tick — permanent failure fails immediately (Req 6.6)', () => {
  test('a non-transient error is not retried; item failed, failed_count bumped, others continue', async () => {
    const items = makeItemStore([
      { id: 1, job_id: 10, to_e164: '+1', raw_input: 'x', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
      { id: 2, job_id: 10, to_e164: '+2', raw_input: 'y', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ]);
    const jobs = makeJobStore([
      { id: 10, template_name: 'promo', language: 'en_US', msg_type: 'template', status: 'running', sent_count: 0, failed_count: 0 },
    ]);
    const message = { insert: jest.fn(async () => 1) };
    const whatsappService = {
      // First item: permanent error. Second item: success (continues, Req 6.6).
      sendTemplate: jest
        .fn()
        .mockResolvedValueOnce({ ok: false, code: '132001', title: 'Template does not exist', detail: 'nope' })
        .mockResolvedValueOnce({ ok: true, wamid: 'wamid.SECOND' }),
      sendText: jest.fn(),
    };

    const w = worker.createWorker({
      config: cfg,
      whatsappService,
      bulkJob: jobs,
      bulkJobItem: items,
      message,
      delay: jest.fn(async () => {}),
      logger: silentLogger,
    });

    const summary = await w.tick();

    expect(summary).toMatchObject({ claimed: 2, sent: 1, requeued: 0, failed: 1 });
    expect(items.store.rows[0].status).toBe('failed');
    expect(items.store.rows[0].error_detail).toContain('Template does not exist');
    expect(items.requeue).not.toHaveBeenCalled();
    expect(items.store.rows[1].status).toBe('sent'); // continued despite item 1's failure
    expect(jobs.store.jobs[0].failed_count).toBe(1);
    expect(jobs.store.jobs[0].sent_count).toBe(1);
    expect(jobs.store.jobs[0].status).toBe('completed');
  });
});

// -------------------- tick: item-level error isolation --------------------

describe('tick — item error isolation (NFR-2)', () => {
  test('a thrown send is caught, item marked failed, tick does not throw', async () => {
    const items = makeItemStore([
      { id: 1, job_id: 10, to_e164: '+1', raw_input: 'x', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ]);
    const jobs = makeJobStore([
      { id: 10, template_name: 'promo', language: 'en_US', msg_type: 'template', status: 'running', sent_count: 0, failed_count: 0 },
    ]);
    const whatsappService = {
      sendTemplate: jest.fn(async () => {
        throw new Error('boom');
      }),
      sendText: jest.fn(),
    };

    const w = worker.createWorker({
      config: cfg,
      whatsappService,
      bulkJob: jobs,
      bulkJobItem: items,
      message: { insert: jest.fn() },
      delay: jest.fn(async () => {}),
      logger: silentLogger,
    });

    await expect(w.tick()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    expect(items.store.rows[0].status).toBe('failed');
    expect(jobs.store.jobs[0].failed_count).toBe(1);
  });
});

// -------------------- tick: overlap lock --------------------

describe('tick — overlap lock (NFR-2)', () => {
  test('a re-entrant tick is skipped while one is running', async () => {
    let releaseClaim;
    const claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });

    const items = {
      claimPending: jest.fn(async () => {
        await claimGate; // hold the first tick open
        return [];
      }),
      markSent: jest.fn(),
      markFailed: jest.fn(),
      requeue: jest.fn(),
      resetStuckProcessing: jest.fn(),
      countOutstanding: jest.fn(async () => 0),
    };

    const w = worker.createWorker({
      config: cfg,
      whatsappService: { sendTemplate: jest.fn(), sendText: jest.fn() },
      bulkJob: makeJobStore([]),
      bulkJobItem: items,
      message: { insert: jest.fn() },
      delay: jest.fn(async () => {}),
      logger: silentLogger,
    });

    const first = w.tick(); // starts, blocks on claimGate
    const second = await w.tick(); // should be skipped immediately

    expect(second).toMatchObject({ skipped: true });
    expect(items.claimPending).toHaveBeenCalledTimes(1);

    releaseClaim();
    await first;
    expect(w.isRunning()).toBe(false);
  });
});

// -------------------- reconciler --------------------

describe('reconcile — crash-safe resume (Req 6.9)', () => {
  test('resets stuck processing (wamid IS NULL) but leaves ones with a wamid', async () => {
    const items = makeItemStore([
      // Stuck, no wamid → should reset.
      { id: 1, job_id: 10, to_e164: '+1', raw_input: 'a', variables: null, status: 'processing', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
      // Stuck but HAS a wamid (was actually sent) → must NOT reset (double-send guard).
      { id: 2, job_id: 10, to_e164: '+2', raw_input: 'b', variables: null, status: 'processing', attempts: 0, wamid: 'wamid.SENT', next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
      // Pending → untouched.
      { id: 3, job_id: 10, to_e164: '+3', raw_input: 'c', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ]);

    const w = worker.createWorker({
      config: cfg,
      whatsappService: { sendTemplate: jest.fn(), sendText: jest.fn() },
      bulkJob: makeJobStore([]),
      bulkJobItem: items,
      message: { insert: jest.fn() },
      delay: jest.fn(async () => {}),
      now: () => Date.parse('2024-06-01T00:00:00Z'), // well after the stuck timestamps
      logger: silentLogger,
    });

    const result = await w.reconcile();

    expect(result.reset).toBe(1);
    expect(items.store.rows[0].status).toBe('pending'); // reset
    expect(items.store.rows[1].status).toBe('processing'); // left alone (has wamid)
    expect(items.store.rows[1].wamid).toBe('wamid.SENT');
    expect(items.store.rows[2].status).toBe('pending'); // untouched
    expect(items.resetStuckProcessing).toHaveBeenCalledTimes(1);
  });
});

// -------------------- multi-tick progression --------------------

describe('multi-tick progression (Req 6.3, 6.4)', () => {
  test('a requeued item is retried on a later tick once its next_attempt_at is due', async () => {
    const items = makeItemStore([
      { id: 1, job_id: 10, to_e164: '+1', raw_input: 'x', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ]);
    const jobs = makeJobStore([
      { id: 10, template_name: 'promo', language: 'en_US', msg_type: 'template', status: 'running', sent_count: 0, failed_count: 0 },
    ]);
    const message = { insert: jest.fn(async () => 1) };
    const whatsappService = {
      // Tick 1: transient 429 → requeue. Tick 2: success.
      sendTemplate: jest
        .fn()
        .mockResolvedValueOnce({ ok: false, code: 429, title: 'rate', detail: 'limit' })
        .mockResolvedValueOnce({ ok: true, wamid: 'wamid.RETRIED' }),
      sendText: jest.fn(),
    };

    // Clock we advance between ticks so the backoff window elapses.
    let clock = Date.parse('2024-06-01T00:00:00Z');
    const w = worker.createWorker({
      config: cfg,
      whatsappService,
      bulkJob: jobs,
      bulkJobItem: items,
      message,
      delay: jest.fn(async () => {}),
      now: () => clock,
      logger: silentLogger,
    });

    const t1 = await w.tick();
    expect(t1).toMatchObject({ requeued: 1 });
    expect(items.store.rows[0].status).toBe('pending');
    expect(items.store.rows[0].attempts).toBe(1);

    // The fake claim treats due-ness by real Date.now(); the requeued row's
    // next_attempt_at is fixedNow+1000 which is in 2024 — already <= real now,
    // so it's due on the next tick.
    const t2 = await w.tick();
    expect(t2).toMatchObject({ sent: 1 });
    expect(items.store.rows[0].status).toBe('sent');
    expect(items.store.rows[0].wamid).toBe('wamid.RETRIED');
    expect(jobs.store.jobs[0].status).toBe('completed');
  });
});

// -------------------- startWorker guard --------------------

describe('startWorker driver guard (design §6, NFR-6)', () => {
  test('is a no-op for the bullmq driver', async () => {
    const res = await worker.startWorker({ config: { queue: { driver: 'bullmq' }, worker: cfg.worker } });
    expect(res.started).toBe(false);
    expect(res.task).toBeNull();
  });
});
