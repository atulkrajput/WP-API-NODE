'use strict';

/**
 * Retry-failed tests — Requirement 8.5, NFR-6 (Task 15, optional stretch).
 *
 * Scope: POST /bulk/:id/retry-failed re-queues a job's failed items (via
 * bulkJobItem.retryFailed), decrements the job's failed_count by the number
 * re-queued, and sets the job running again so the worker resumes it. Unknown
 * jobs → 404; auth + CSRF are enforced. A follow-up worker tick (using the
 * in-memory worker fakes) then processes the re-queued items to prove the full
 * loop. The bulkJob / bulkJobItem / admin models are mocked (no live MySQL);
 * auth uses a real session + CSRF handshake.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/models/admin');
jest.mock('../src/models/bulkJob');
jest.mock('../src/models/bulkJobItem');

const adminModel = require('../src/models/admin');
const bulkJobModel = require('../src/models/bulkJob');
const bulkJobItemModel = require('../src/models/bulkJobItem');

const createApp = require('../src/app');
const worker = require('../src/worker/worker');

const ADMIN = {
  id: 1,
  username: 'admin',
  password_hash: bcrypt.hashSync('correct-horse', 10),
  created_at: '2024-01-01 00:00:00',
};

const JOB = {
  id: 7,
  name: 'April promo',
  template_name: 'promo_v1',
  language: 'en_US',
  msg_type: 'template',
  status: 'completed',
  total_count: 5,
  sent_count: 2,
  failed_count: 2,
  skipped_count: 1,
  created_at: '2024-04-01 12:00:00',
  updated_at: '2024-04-01 12:05:00',
};

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Return an authenticated agent + a fresh CSRF token. The session id (and thus
 * the CSRF token) is regenerated on login for fixation safety, so the token
 * MUST be read from a page rendered AFTER login — not the login page.
 */
async function authedAgent(app) {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  await agent
    .post('/login')
    .type('form')
    .send({ username: 'admin', password: 'correct-horse', _csrf: extractCsrf(loginPage.text) });
  // Post-login page carries the regenerated session's CSRF token.
  bulkJobModel.list.mockResolvedValue([]);
  const page = await agent.get('/bulk');
  return { agent, token: extractCsrf(page.text) };
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  adminModel.findByUsername.mockImplementation(async (username) =>
    username === ADMIN.username ? ADMIN : null
  );
  app = createApp();
});

describe('POST /bulk/:id/retry-failed (Requirement 8.5)', () => {
  test('re-queues failed items, decrements failed_count, sets job running', async () => {
    const { agent, token } = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue(JOB);
    bulkJobItemModel.retryFailed.mockResolvedValue(2); // both failed re-queued
    bulkJobModel.updateCounters.mockResolvedValue(true);
    bulkJobModel.updateStatus.mockResolvedValue(true);

    const res = await agent
      .post('/bulk/7/retry-failed')
      .set('Accept', 'application/json')
      .send({ _csrf: token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, jobId: 7, requeued: 2, status: 'running' });

    // retryFailed called for the job.
    expect(bulkJobItemModel.retryFailed).toHaveBeenCalledWith(7);

    // failed_count decremented by the re-queued count (2 → 0).
    expect(bulkJobModel.updateCounters).toHaveBeenCalledWith(7, { failedCount: 0 });

    // Job set back to running so the worker resumes it.
    expect(bulkJobModel.updateStatus).toHaveBeenCalledWith(7, 'running');
  });

  test('re-queued items are then processed by a follow-up worker tick', async () => {
    // Prove the loop closes: after retry-failed flips items to pending, a worker
    // tick claims and sends them. We reuse the in-memory worker fakes pattern
    // (see worker.test.js): the item store starts with two pending rows (as the
    // model's retryFailed would have left them) and a tick drains them.
    const rows = [
      { id: 101, job_id: 7, to_e164: '+12025550182', raw_input: 'x', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
      { id: 102, job_id: 7, to_e164: '+442071838750', raw_input: 'y', variables: null, status: 'pending', attempts: 0, wamid: null, next_attempt_at: null, updated_at: '2024-01-01 00:00:00' },
    ];
    const itemStore = { rows };
    const itemFake = {
      claimPending: jest.fn(async (limit) => {
        const due = itemStore.rows.filter((r) => r.status === 'pending').slice(0, limit);
        due.forEach((r) => { r.status = 'processing'; });
        return due.map((r) => ({ ...r }));
      }),
      markSent: jest.fn(async (id, wamid) => {
        const r = itemStore.rows.find((x) => x.id === id);
        r.status = 'sent';
        r.wamid = wamid;
        return true;
      }),
      markFailed: jest.fn(async () => true),
      requeue: jest.fn(async () => true),
      resetStuckProcessing: jest.fn(async () => 0),
      countOutstanding: jest.fn(async (jobId) =>
        itemStore.rows.filter((r) => r.job_id === jobId && (r.status === 'pending' || r.status === 'processing')).length
      ),
    };
    const jobRow = { id: 7, template_name: 'promo_v1', language: 'en_US', msg_type: 'template', status: 'running', sent_count: 0, failed_count: 0 };
    const jobFake = {
      getById: jest.fn(async () => ({ ...jobRow })),
      updateStatus: jest.fn(async (id, status) => { jobRow.status = status; return true; }),
      updateCounters: jest.fn(async () => true),
    };
    const whatsappService = {
      sendTemplate: jest.fn(async () => ({ ok: true, wamid: 'wamid.RETRIED' })),
      sendText: jest.fn(),
    };

    const w = worker.createWorker({
      config: { worker: { sendDelayMs: 0, batch: 5, maxAttempts: 3 }, queue: { driver: 'db' } },
      whatsappService,
      bulkJob: jobFake,
      bulkJobItem: itemFake,
      message: { insert: jest.fn(async () => 1) },
      delay: jest.fn(async () => {}),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const summary = await w.tick();

    expect(summary).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
    expect(itemStore.rows.every((r) => r.status === 'sent')).toBe(true);
    // Job completed once nothing outstanding.
    expect(jobFake.updateStatus).toHaveBeenCalledWith(7, 'completed');
  });

  test('when nothing is re-queued, counters/status untouched', async () => {
    const { agent, token } = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue({ ...JOB, failed_count: 0 });
    bulkJobItemModel.retryFailed.mockResolvedValue(0);

    const res = await agent
      .post('/bulk/7/retry-failed')
      .set('Accept', 'application/json')
      .send({ _csrf: token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, requeued: 0 });
    expect(bulkJobModel.updateCounters).not.toHaveBeenCalled();
    expect(bulkJobModel.updateStatus).not.toHaveBeenCalled();
  });

  test('failed_count never decrements below zero', async () => {
    const { agent, token } = await authedAgent(app);

    // Stored failed_count (1) is less than re-queued (2) — guard against negative.
    bulkJobModel.getById.mockResolvedValue({ ...JOB, failed_count: 1 });
    bulkJobItemModel.retryFailed.mockResolvedValue(2);

    await agent
      .post('/bulk/7/retry-failed')
      .set('Accept', 'application/json')
      .send({ _csrf: token });

    expect(bulkJobModel.updateCounters).toHaveBeenCalledWith(7, { failedCount: 0 });
  });

  test('non-JSON POST redirects back to the job detail page', async () => {
    const { agent, token } = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue(JOB);
    bulkJobItemModel.retryFailed.mockResolvedValue(2);

    const res = await agent
      .post('/bulk/7/retry-failed')
      .type('form')
      .send({ _csrf: token });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/bulk/7');
  });

  test('unknown job → 404 JSON', async () => {
    const { agent, token } = await authedAgent(app);
    bulkJobModel.getById.mockResolvedValue(null);

    const res = await agent
      .post('/bulk/999/retry-failed')
      .set('Accept', 'application/json')
      .send({ _csrf: token });

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('not_found');
    expect(bulkJobItemModel.retryFailed).not.toHaveBeenCalled();
  });

  test('rejects missing/invalid CSRF token (403)', async () => {
    const { agent } = await authedAgent(app);
    bulkJobModel.getById.mockResolvedValue(JOB);

    const res = await agent
      .post('/bulk/7/retry-failed')
      .set('Accept', 'application/json')
      .send({}); // no _csrf

    expect(res.status).toBe(403);
    expect(bulkJobItemModel.retryFailed).not.toHaveBeenCalled();
  });

  test('requires authentication', async () => {
    const res = await request(app).post('/bulk/7/retry-failed').send({});
    expect([302, 403]).toContain(res.status);
    expect(bulkJobModel.getById).not.toHaveBeenCalled();
  });
});
