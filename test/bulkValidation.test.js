'use strict';

/**
 * Bulk CSV validation tests — Requirement 4 (Tier A bulk validation).
 *
 * The validation_results model is mocked (no live MySQL); PhoneService
 * (libphonenumber-js) runs for real, and CSVs are uploaded as buffers via
 * supertest .attach(). The admin model is mocked to support authenticated
 * sessions. Assertions cover:
 *   - valid CSV → JSON report with valid/invalid/duplicate counts (Req 4.2, 4.4)
 *   - persistence under a single batch_id (Req 4.6)
 *   - oversized file rejected with a clear error (Req 4.3)
 *   - non-CSV MIME/extension rejected with a clear error (Req 4.3)
 *   - CSRF token supplied via the x-csrf-token header (multipart decision)
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
// Small size cap so the oversized-file test stays fast.
process.env.UPLOAD_MAX_BYTES = '200';

const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/models/admin');
jest.mock('../src/models/validationResult');

const adminModel = require('../src/models/admin');
const validationResultModel = require('../src/models/validationResult');

const createApp = require('../src/app');

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
    .send({ username: 'admin', password: 'correct-horse', _csrf: extractCsrf(loginPage.text) });

  const bulkPage = await agent.get('/validate/bulk');
  return { agent, token: extractCsrf(bulkPage.text) };
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  adminModel.findByUsername.mockImplementation(async (username) =>
    username === ADMIN.username ? ADMIN : null
  );
  validationResultModel.insert.mockResolvedValue(1);
  validationResultModel.insertMany.mockResolvedValue(0);
  app = createApp();
});

describe('POST /validate/bulk — Tier A bulk validation (Requirement 4)', () => {
  test('valid CSV → report with valid/invalid/duplicate counts + batch persistence', async () => {
    const { agent, token } = await authedAgent(app);

    // 4 rows: two identical valid US numbers (one duplicate), one valid GB, one invalid.
    const csv =
      'phone\n' +
      '+12025550182\n' +
      '+442071838750\n' +
      '+1 202 555 0182\n' + // duplicate of row 1's E.164
      '123\n';

    const res = await agent
      .post('/validate/bulk')
      .set('x-csrf-token', token)
      .field('format', 'json')
      .field('phoneColumn', 'phone')
      .attach('file', Buffer.from(csv), { filename: 'numbers.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tier).toBe('A');
    expect(res.body.summary.total).toBe(4);
    expect(res.body.summary.valid).toBe(3);
    expect(res.body.summary.invalid).toBe(1);
    expect(res.body.summary.duplicate).toBe(1);
    expect(res.body.summary.kept).toBe(2);
    expect(typeof res.body.batchId).toBe('string');
    expect(res.body.batchId.length).toBeGreaterThan(0);

    // Req 4.6 — persisted under a single batch id via bulk insert.
    expect(validationResultModel.insertMany).toHaveBeenCalledTimes(1);
    const persistedRows = validationResultModel.insertMany.mock.calls[0][0];
    expect(persistedRows).toHaveLength(4);
    const batchIds = new Set(persistedRows.map((r) => r.batchId));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toBe(res.body.batchId);
    expect(persistedRows.every((r) => r.checkType === 'format')).toBe(true);
  });

  test('configurable column + default country (Requirement 4.1)', async () => {
    const { agent, token } = await authedAgent(app);
    const csv = 'msisdn\n(202) 555-0182\n';

    const res = await agent
      .post('/validate/bulk')
      .set('x-csrf-token', token)
      .field('format', 'json')
      .field('phoneColumn', 'msisdn')
      .field('defaultCountry', 'US')
      .attach('file', Buffer.from(csv), { filename: 'numbers.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body.summary.valid).toBe(1);
    expect(res.body.rows[0].e164).toBe('+12025550182');
  });

  test('oversized file rejected with a clear error (Requirement 4.3)', async () => {
    const { agent, token } = await authedAgent(app);
    // UPLOAD_MAX_BYTES is 200; make the file bigger than that.
    const big = 'phone\n' + '+12025550182\n'.repeat(50);
    expect(Buffer.byteLength(big)).toBeGreaterThan(200);

    const res = await agent
      .post('/validate/bulk')
      .set('x-csrf-token', token)
      .attach('file', Buffer.from(big), { filename: 'big.csv', contentType: 'text/csv' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('file_too_large');
    expect(res.body.message).toMatch(/limit/i);
    expect(validationResultModel.insertMany).not.toHaveBeenCalled();
  });

  test('non-CSV MIME/extension rejected with a clear error (Requirement 4.3)', async () => {
    const { agent, token } = await authedAgent(app);

    const res = await agent
      .post('/validate/bulk')
      .set('x-csrf-token', token)
      .attach('file', Buffer.from('not,a,csv'), {
        filename: 'evil.exe',
        contentType: 'application/x-msdownload',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_file_type');
    expect(res.body.message).toMatch(/csv/i);
    expect(validationResultModel.insertMany).not.toHaveBeenCalled();
  });

  test('missing CSRF header is rejected (multipart CSRF via header)', async () => {
    const { agent } = await authedAgent(app);
    const csv = 'phone\n+12025550182\n';

    const res = await agent
      .post('/validate/bulk')
      .attach('file', Buffer.from(csv), { filename: 'numbers.csv', contentType: 'text/csv' });

    expect(res.status).toBe(403);
    expect(validationResultModel.insertMany).not.toHaveBeenCalled();
  });

  test('unauthenticated upload never reaches the handler', async () => {
    const csv = 'phone\n+12025550182\n';
    const res = await request(app)
      .post('/validate/bulk')
      .attach('file', Buffer.from(csv), { filename: 'numbers.csv', contentType: 'text/csv' });

    expect([302, 403]).toContain(res.status);
    expect(validationResultModel.insertMany).not.toHaveBeenCalled();
  });
});

describe('buildReport unit — dedupe summary (Requirement 4.4)', () => {
  const { buildReport } = require('../src/controllers/validation');

  test('first occurrence kept, later identical E.164 marked duplicate', () => {
    const records = [
      { phone: '+12025550182' },
      { phone: '(202) 555-0182' }, // same E.164
      { phone: '+442071838750' },
    ];
    const { rows, summary } = buildReport(records, { phoneColumn: 'phone', defaultCountry: 'US' });
    expect(summary.total).toBe(3);
    expect(summary.valid).toBe(3);
    expect(summary.kept).toBe(2);
    expect(summary.duplicate).toBe(1);
    expect(rows[0].duplicate).toBe(false);
    expect(rows[1].duplicate).toBe(true);
    expect(rows[2].duplicate).toBe(false);
  });
});
