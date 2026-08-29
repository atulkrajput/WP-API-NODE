'use strict';

/**
 * Bulk send job creation tests — Requirement 6.1 & 6.2 (Task 10).
 *
 * Scope: uploading a recipient CSV creates ONE bulk_jobs row and one
 * bulk_job_items row per recipient. Tier A runs during import; invalid rows are
 * recorded as `skipped_invalid` and NOT queued, and the job counters reflect the
 * skipped count. Sending itself is Task 11 and is NOT exercised here.
 *
 * The bulkJob / bulkJobItem models are mocked (no live MySQL), the admin model
 * is mocked to support authenticated sessions, PhoneService (libphonenumber-js)
 * runs for real, and CSVs are uploaded as buffers via supertest .attach().
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
const queueService = require('../src/services/queueService');
const bulkController = require('../src/controllers/bulk');

const ADMIN = {
  id: 1,
  username: 'admin',
  password_hash: bcrypt.hashSync('correct-horse', 10),
  created_at: '2024-01-01 00:00:00',
};

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

/** Return an authenticated agent plus a CSRF token from the bulk page. */
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

  const bulkPage = await agent.get('/bulk');
  return { agent, token: extractCsrf(bulkPage.text) };
}

let app;
let nextJobId;

beforeEach(() => {
  jest.clearAllMocks();
  nextJobId = 42;

  adminModel.findByUsername.mockImplementation(async (username) =>
    username === ADMIN.username ? ADMIN : null
  );

  // list() powers both GET /bulk and the re-render after create.
  bulkJobModel.list.mockResolvedValue([]);
  // create() returns a fresh job id and records the payload for assertions.
  bulkJobModel.create.mockImplementation(async () => nextJobId);
  bulkJobItemModel.insertMany.mockResolvedValue(0);

  app = createApp();
});

describe('POST /bulk — job creation (Requirement 6.1, 6.2)', () => {
  test('valid CSV → one job row + N item rows with correct statuses/counters', async () => {
    const { agent, token } = await authedAgent(app);

    // 3 valid recipients, 1 invalid ("123") → 4 rows total, 3 queued, 1 skipped.
    const csv =
      'phone,first_name,city\n' +
      '+12025550182,Alice,NYC\n' +
      '+442071838750,Bob,London\n' +
      '+14155550123,Carol,SF\n' +
      '123,Mallory,Nowhere\n';

    const res = await agent
      .post('/bulk')
      .set('x-csrf-token', token)
      .field('format', 'json')
      .field('templateName', 'promo_v1')
      .field('language', 'en_US')
      .field('phoneColumn', 'phone')
      .field('name', 'April promo')
      // Variable mapping: {{1}} ← first_name, {{2}} ← city.
      .field('varColumn', 'first_name')
      .field('varColumn', 'city')
      .attach('file', Buffer.from(csv), {
        filename: 'recipients.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.jobId).toBe(42);
    expect(res.body.status).toBe('running'); // has pending items
    expect(res.body.counts).toEqual({ total: 4, pending: 3, skipped: 1 });

    // Exactly ONE bulk_jobs row created (Req 6.1).
    expect(bulkJobModel.create).toHaveBeenCalledTimes(1);
    const jobArg = bulkJobModel.create.mock.calls[0][0];
    expect(jobArg.templateName).toBe('promo_v1');
    expect(jobArg.language).toBe('en_US');
    expect(jobArg.name).toBe('April promo');
    expect(jobArg.status).toBe('running');
    expect(jobArg.totalCount).toBe(4);
    expect(jobArg.skippedCount).toBe(1); // counters reflect skipped (Req 6.8)
    expect(jobArg.sentCount).toBe(0);
    expect(jobArg.failedCount).toBe(0);
    // variables_map persisted as position → column.
    expect(jobArg.variablesMap).toEqual({ 1: 'first_name', 2: 'city' });

    // One bulk_job_items row per recipient (Req 6.1).
    expect(bulkJobItemModel.insertMany).toHaveBeenCalledTimes(1);
    const [jobId, items] = bulkJobItemModel.insertMany.mock.calls[0];
    expect(jobId).toBe(42);
    expect(items).toHaveLength(4);

    const pending = items.filter((i) => i.status === 'pending');
    const skipped = items.filter((i) => i.status === 'skipped_invalid');
    expect(pending).toHaveLength(3);
    expect(skipped).toHaveLength(1);

    // Valid rows: E.164 resolved, variables resolved, ready to send now.
    const alice = items.find((i) => i.rawInput === '+12025550182');
    expect(alice.status).toBe('pending');
    expect(alice.toE164).toBe('+12025550182');
    expect(alice.variables).toEqual({ 1: 'Alice', 2: 'NYC' });
    expect(alice.nextAttemptAt).toBeTruthy();

    // Invalid row: recorded as skipped_invalid, NOT sendable, no next_attempt.
    expect(skipped[0].rawInput).toBe('123');
    expect(skipped[0].toE164).toBeNull();
    expect(skipped[0].nextAttemptAt).toBeNull();
  });

  test('invalid rows are skipped and not counted as sendable (Req 6.2)', async () => {
    const { agent, token } = await authedAgent(app);

    // Only invalid numbers → nothing to send → job completed on arrival.
    const csv = 'phone\nabc\n12\n';

    const res = await agent
      .post('/bulk')
      .set('x-csrf-token', token)
      .field('format', 'json')
      .field('templateName', 'promo_v1')
      .field('language', 'en_US')
      .attach('file', Buffer.from(csv), {
        filename: 'bad.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(201);
    expect(res.body.counts).toEqual({ total: 2, pending: 0, skipped: 2 });
    expect(res.body.status).toBe('completed'); // no pending items

    const jobArg = bulkJobModel.create.mock.calls[0][0];
    expect(jobArg.status).toBe('completed');
    expect(jobArg.skippedCount).toBe(2);
    expect(jobArg.totalCount).toBe(2);

    const [, items] = bulkJobItemModel.insertMany.mock.calls[0];
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === 'skipped_invalid')).toBe(true);
    expect(items.every((i) => i.toE164 === null)).toBe(true);
    expect(items.every((i) => i.nextAttemptAt === null)).toBe(true);
  });

  test('missing template name/language is rejected (no job created)', async () => {
    const { agent, token } = await authedAgent(app);
    const csv = 'phone\n+12025550182\n';

    const res = await agent
      .post('/bulk')
      .set('x-csrf-token', token)
      .field('format', 'json')
      .field('language', 'en_US') // templateName missing
      .attach('file', Buffer.from(csv), {
        filename: 'recipients.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_template');
    expect(bulkJobModel.create).not.toHaveBeenCalled();
    expect(bulkJobItemModel.insertMany).not.toHaveBeenCalled();
  });

  test('CSV without the phone column is rejected (no job created)', async () => {
    const { agent, token } = await authedAgent(app);
    const csv = 'msisdn\n+12025550182\n'; // phoneColumn defaults to "phone"

    const res = await agent
      .post('/bulk')
      .set('x-csrf-token', token)
      .field('format', 'json')
      .field('templateName', 'promo_v1')
      .field('language', 'en_US')
      .attach('file', Buffer.from(csv), {
        filename: 'recipients.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_column');
    expect(bulkJobModel.create).not.toHaveBeenCalled();
  });

  test('missing CSRF header is rejected (multipart CSRF via header)', async () => {
    const { agent } = await authedAgent(app);
    const csv = 'phone\n+12025550182\n';

    const res = await agent
      .post('/bulk')
      .field('templateName', 'promo_v1')
      .field('language', 'en_US')
      .attach('file', Buffer.from(csv), {
        filename: 'recipients.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(403);
    expect(bulkJobModel.create).not.toHaveBeenCalled();
  });

  test('unauthenticated upload never reaches the handler', async () => {
    const csv = 'phone\n+12025550182\n';
    const res = await request(app)
      .post('/bulk')
      .field('templateName', 'promo_v1')
      .field('language', 'en_US')
      .attach('file', Buffer.from(csv), {
        filename: 'recipients.csv',
        contentType: 'text/csv',
      });

    expect([302, 403]).toContain(res.status);
    expect(bulkJobModel.create).not.toHaveBeenCalled();
  });
});

describe('QueueService.enqueueJob (design §6 enqueue)', () => {
  test('valid + invalid rows → running job, counters, item statuses', async () => {
    const bulkJob = { create: jest.fn().mockResolvedValue(7) };
    const bulkJobItem = { insertMany: jest.fn().mockResolvedValue(3) };

    const rows = [
      { rawInput: '+12025550182', toE164: '+12025550182', variables: { 1: 'A' }, valid: true },
      { rawInput: '+442071838750', toE164: '+442071838750', variables: { 1: 'B' }, valid: true },
      { rawInput: '123', toE164: null, variables: null, valid: false, reason: 'too short' },
    ];

    const result = await queueService.enqueueJob(
      { templateName: 't', language: 'en_US', variablesMap: { 1: 'name' } },
      rows,
      { bulkJob, bulkJobItem }
    );

    expect(result).toEqual({ jobId: 7, status: 'running', total: 3, pending: 2, skipped: 1 });

    const jobArg = bulkJob.create.mock.calls[0][0];
    expect(jobArg.status).toBe('running');
    expect(jobArg.totalCount).toBe(3);
    expect(jobArg.skippedCount).toBe(1);

    const [jobId, items] = bulkJobItem.insertMany.mock.calls[0];
    expect(jobId).toBe(7);
    expect(items.filter((i) => i.status === 'pending')).toHaveLength(2);
    const skipped = items.find((i) => i.status === 'skipped_invalid');
    expect(skipped.errorDetail).toBe('too short');
    expect(skipped.nextAttemptAt).toBeNull();
  });

  test('all-invalid rows → completed job with nothing queued', async () => {
    const bulkJob = { create: jest.fn().mockResolvedValue(8) };
    const bulkJobItem = { insertMany: jest.fn().mockResolvedValue(1) };

    const result = await queueService.enqueueJob(
      { templateName: 't', language: 'en_US' },
      [{ rawInput: 'x', toE164: null, valid: false, reason: 'bad' }],
      { bulkJob, bulkJobItem }
    );

    expect(result.status).toBe('completed');
    expect(result.pending).toBe(0);
    expect(result.skipped).toBe(1);
    expect(bulkJob.create.mock.calls[0][0].status).toBe('completed');
  });
});

describe('bulk controller helpers', () => {
  test('parseVariablesMap: positional varColumn[] → position map', () => {
    const map = bulkController.parseVariablesMap({ varColumn: ['first_name', '', 'city'] });
    // Empty slots are skipped; positions are 1-based by array index.
    expect(map).toEqual({ 1: 'first_name', 3: 'city' });
  });

  test('parseVariablesMap: JSON string mapping wins when present', () => {
    const map = bulkController.parseVariablesMap({
      variablesMap: '{"1":"name","2":"town"}',
    });
    expect(map).toEqual({ 1: 'name', 2: 'town' });
  });

  test('parseVariablesMap: no mapping → empty object', () => {
    expect(bulkController.parseVariablesMap({})).toEqual({});
  });

  test('resolveRowVariables: resolves mapped columns in position order', () => {
    const resolved = bulkController.resolveRowVariables(
      { first_name: 'Alice', city: 'NYC', unused: 'x' },
      { 1: 'first_name', 2: 'city' }
    );
    expect(resolved).toEqual({ 1: 'Alice', 2: 'NYC' });
  });

  test('resolveRowVariables: missing column resolves to empty string', () => {
    const resolved = bulkController.resolveRowVariables(
      { first_name: 'Alice' },
      { 1: 'first_name', 2: 'city' }
    );
    expect(resolved).toEqual({ 1: 'Alice', 2: '' });
  });

  test('resolveRowVariables: no mapping → null', () => {
    expect(bulkController.resolveRowVariables({ a: 'b' }, {})).toBeNull();
  });
});
