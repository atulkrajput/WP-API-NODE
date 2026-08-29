'use strict';

/**
 * Bulk job history & progress tests — Requirement 8 (Task 12).
 *
 * Scope: the job detail page (GET /bulk/:id) shows per-item rows and honors the
 * `?status=` filter (delegating to listByJob), and the progress endpoint
 * (GET /bulk/:id/progress) returns live X-of-Y counts derived from the model.
 * Unknown jobs return 404. The bulkJob / bulkJobItem / admin models are mocked
 * (no live MySQL); auth uses a real session + CSRF handshake.
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
const bulkController = require('../src/controllers/bulk');

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
  status: 'running',
  total_count: 5,
  sent_count: 2,
  failed_count: 1,
  skipped_count: 1,
  created_at: '2024-04-01 12:00:00',
  updated_at: '2024-04-01 12:05:00',
};

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

/** Return an authenticated agent (session established via login). */
async function authedAgent(app) {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  await agent
    .post('/login')
    .type('form')
    .send({
      username: 'admin',
      password: 'correct-horse',
      _csrf: extractCsrf(loginPage.text),
    });
  return agent;
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  adminModel.findByUsername.mockImplementation(async (username) =>
    username === ADMIN.username ? ADMIN : null
  );
  app = createApp();
});

describe('GET /bulk/:id — job detail (Requirement 8.2, 8.4)', () => {
  test('renders per-item rows with recipient, status, wamid, and reason', async () => {
    const agent = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue(JOB);
    bulkJobItemModel.listByJob.mockResolvedValue([
      {
        id: 101,
        to_e164: '+12025550182',
        raw_input: '+12025550182',
        status: 'sent',
        attempts: 1,
        wamid: 'wamid.ABC123',
        error_detail: null,
      },
      {
        id: 102,
        to_e164: '+14155550123',
        raw_input: '+14155550123',
        status: 'failed',
        attempts: 3,
        wamid: null,
        error_detail: 'Recipient not on WhatsApp',
      },
    ]);
    bulkJobItemModel.countsByStatus.mockResolvedValue({
      pending: 1,
      processing: 0,
      sent: 2,
      failed: 1,
      skipped_invalid: 1,
    });

    const res = await agent.get('/bulk/7');

    expect(res.status).toBe(200);
    // Recipient + wamid + failure reason all rendered (Req 8.2).
    expect(res.text).toContain('+12025550182');
    expect(res.text).toContain('wamid.ABC123');
    expect(res.text).toContain('+14155550123');
    expect(res.text).toContain('Recipient not on WhatsApp');
    // Job header.
    expect(res.text).toContain('promo_v1');

    // No status filter → listByJob called with an empty filter.
    expect(bulkJobItemModel.listByJob).toHaveBeenCalledTimes(1);
    const [jobId, opts] = bulkJobItemModel.listByJob.mock.calls[0];
    expect(jobId).toBe(7);
    expect(opts).toEqual({});
  });

  test('?status=failed narrows the list via listByJob (Req 8.4)', async () => {
    const agent = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue(JOB);
    bulkJobItemModel.listByJob.mockResolvedValue([
      {
        id: 102,
        to_e164: '+14155550123',
        raw_input: '+14155550123',
        status: 'failed',
        attempts: 3,
        wamid: null,
        error_detail: 'Recipient not on WhatsApp',
      },
    ]);
    bulkJobItemModel.countsByStatus.mockResolvedValue({
      pending: 1,
      processing: 0,
      sent: 2,
      failed: 1,
      skipped_invalid: 1,
    });

    const res = await agent.get('/bulk/7?status=failed');

    expect(res.status).toBe(200);
    // The filter is forwarded to the model.
    const [jobId, opts] = bulkJobItemModel.listByJob.mock.calls[0];
    expect(jobId).toBe(7);
    expect(opts).toEqual({ status: 'failed' });
  });

  test('unknown ?status value is ignored (no filter passed)', async () => {
    const agent = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue(JOB);
    bulkJobItemModel.listByJob.mockResolvedValue([]);
    bulkJobItemModel.countsByStatus.mockResolvedValue({
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      skipped_invalid: 0,
    });

    const res = await agent.get('/bulk/7?status=bogus');

    expect(res.status).toBe(200);
    const [, opts] = bulkJobItemModel.listByJob.mock.calls[0];
    expect(opts).toEqual({});
  });

  test('unknown job → 404', async () => {
    const agent = await authedAgent(app);
    bulkJobModel.getById.mockResolvedValue(null);

    const res = await agent.get('/bulk/999');

    expect(res.status).toBe(404);
    expect(res.text).toContain('not found');
    // Items are never queried for a missing job.
    expect(bulkJobItemModel.listByJob).not.toHaveBeenCalled();
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/bulk/7');
    expect([302, 403]).toContain(res.status);
    expect(bulkJobModel.getById).not.toHaveBeenCalled();
  });
});

describe('GET /bulk/:id/progress — live progress JSON (Requirement 8.3)', () => {
  test('returns live X-of-Y counts derived from the model', async () => {
    const agent = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue(JOB);
    bulkJobItemModel.countsByStatus.mockResolvedValue({
      pending: 1,
      processing: 1,
      sent: 2,
      failed: 1,
      skipped_invalid: 1,
    });

    const res = await agent
      .get('/bulk/7/progress')
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      jobId: 7,
      status: 'running',
      total: 6, // 2 + 1 + 1 + 1 + 1
      sent: 2,
      failed: 1,
      skipped: 1,
      pending: 1,
      processing: 1,
      done: 4, // sent + failed + skipped
      percent: 67, // round(4/6 * 100)
      finished: false,
    });
  });

  test('finished=true when job status is terminal (completed)', async () => {
    const agent = await authedAgent(app);

    bulkJobModel.getById.mockResolvedValue({ ...JOB, status: 'completed' });
    bulkJobItemModel.countsByStatus.mockResolvedValue({
      pending: 0,
      processing: 0,
      sent: 4,
      failed: 0,
      skipped_invalid: 1,
    });

    const res = await agent
      .get('/bulk/7/progress')
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.finished).toBe(true);
    expect(res.body.percent).toBe(100);
    expect(res.body.done).toBe(5);
    expect(res.body.total).toBe(5);
  });

  test('progress reflects live counts changing between polls', async () => {
    const agent = await authedAgent(app);
    bulkJobModel.getById.mockResolvedValue(JOB);

    // First poll: 1 sent of 4.
    bulkJobItemModel.countsByStatus.mockResolvedValueOnce({
      pending: 3,
      processing: 0,
      sent: 1,
      failed: 0,
      skipped_invalid: 0,
    });
    const first = await agent.get('/bulk/7/progress');
    expect(first.body.done).toBe(1);
    expect(first.body.total).toBe(4);
    expect(first.body.percent).toBe(25);

    // Second poll: 3 sent of 4 (worker progressed).
    bulkJobItemModel.countsByStatus.mockResolvedValueOnce({
      pending: 1,
      processing: 0,
      sent: 3,
      failed: 0,
      skipped_invalid: 0,
    });
    const second = await agent.get('/bulk/7/progress');
    expect(second.body.done).toBe(3);
    expect(second.body.percent).toBe(75);
  });

  test('empty job → percent 0, total 0 (no divide-by-zero)', async () => {
    const agent = await authedAgent(app);
    bulkJobModel.getById.mockResolvedValue({ ...JOB, status: 'pending' });
    bulkJobItemModel.countsByStatus.mockResolvedValue({
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      skipped_invalid: 0,
    });

    const res = await agent.get('/bulk/7/progress');
    expect(res.body.total).toBe(0);
    expect(res.body.percent).toBe(0);
    expect(res.body.done).toBe(0);
  });

  test('unknown job → 404 JSON', async () => {
    const agent = await authedAgent(app);
    bulkJobModel.getById.mockResolvedValue(null);

    const res = await agent
      .get('/bulk/999/progress')
      .set('Accept', 'application/json');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('not_found');
    expect(bulkJobItemModel.countsByStatus).not.toHaveBeenCalled();
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/bulk/7/progress');
    expect([302, 403]).toContain(res.status);
    expect(bulkJobModel.getById).not.toHaveBeenCalled();
  });
});

describe('bulk controller — buildProgress helper', () => {
  test('derives total/done/percent from per-status counts', () => {
    const progress = bulkController.buildProgress(
      { id: 1, status: 'running' },
      { pending: 2, processing: 1, sent: 3, failed: 1, skipped_invalid: 1 }
    );
    expect(progress.total).toBe(8);
    expect(progress.done).toBe(5);
    expect(progress.percent).toBe(63); // round(5/8 * 100) = 62.5 → 63
    expect(progress.finished).toBe(false);
  });

  test('tolerates missing count keys (treats as 0)', () => {
    const progress = bulkController.buildProgress(
      { id: 2, status: 'completed' },
      { sent: 1 }
    );
    expect(progress.total).toBe(1);
    expect(progress.done).toBe(1);
    expect(progress.percent).toBe(100);
    expect(progress.finished).toBe(true);
  });
});
