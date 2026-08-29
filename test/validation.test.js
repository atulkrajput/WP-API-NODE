'use strict';

/**
 * Validation tests — Requirement 2 (Tier A single format validation).
 *
 * The validation_results model is mocked so these run without a live MySQL,
 * while PhoneService (libphonenumber-js) runs for real. The admin model is also
 * mocked to support authenticated sessions (POST /validate/single requires auth
 * + CSRF). Assertions cover: valid US/international numbers → E.164, malformed
 * input → clear reason, Tier A labeling, and persistence to validation_results
 * with check_type='format'.
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');

// Mock DB-backed models before requiring the app.
jest.mock('../src/models/admin');
jest.mock('../src/models/validationResult');

const adminModel = require('../src/models/admin');
const validationResultModel = require('../src/models/validationResult');
const phoneService = require('../src/services/phoneService');

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

/** Return an agent with an authenticated session and a fresh CSRF token. */
async function authedAgent(app) {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login');
  const loginToken = extractCsrf(loginPage.text);

  await agent
    .post('/login')
    .type('form')
    .send({ username: 'admin', password: 'correct-horse', _csrf: loginToken });

  // Grab a token from an authenticated page for subsequent POSTs.
  const validatePage = await agent.get('/validate');
  return { agent, token: extractCsrf(validatePage.text) };
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  adminModel.findByUsername.mockImplementation(async (username) =>
    username === ADMIN.username ? ADMIN : null
  );
  validationResultModel.insert.mockResolvedValue(1);
  app = createApp();
});

// -------------------- PhoneService unit tests --------------------

describe('PhoneService.parse — Tier A (Requirement 2.1, 2.2, 2.3)', () => {
  test('valid US national number with default country → E.164 + label', () => {
    const r = phoneService.parse('(202) 555-0182', 'US');
    expect(r.valid).toBe(true);
    expect(r.e164).toBe('+12025550182');
    expect(r.country).toBe('US');
    expect(r.label).toBe('Format valid (Tier A — not a deliverability check)');
    expect(r.reason).toBeNull();
  });

  test('valid international number in +E.164 form → parsed without default country', () => {
    const r = phoneService.parse('+442071838750');
    expect(r.valid).toBe(true);
    expect(r.e164).toBe('+442071838750');
    expect(r.country).toBe('GB');
  });

  test('malformed / too-short number → invalid with a clear reason', () => {
    const r = phoneService.parse('123', 'US');
    expect(r.valid).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
    expect(r.label).toBeNull();
  });

  test('empty input → invalid with reason, no throw', () => {
    const r = phoneService.parse('');
    expect(r.valid).toBe(false);
    expect(r.e164).toBeNull();
    expect(r.reason).toBeTruthy();
  });
});

// -------------------- POST /validate/single integration --------------------

describe('POST /validate/single — Tier A endpoint (Requirement 2.2, 2.4, 2.5)', () => {
  test('valid US number returns E.164, Tier A label, and persists a format row', async () => {
    const { agent, token } = await authedAgent(app);

    const res = await agent
      .post('/validate/single')
      .send({ number: '(202) 555-0182', defaultCountry: 'US', _csrf: token });

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('A');
    expect(res.body.valid).toBe(true);
    expect(res.body.e164).toBe('+12025550182');
    expect(res.body.country).toBe('US');
    expect(res.body.label).toContain('Tier A');
    // Req 2.5 — never claims WhatsApp deliverability.
    expect(res.body.deliverability).toBe('unknown');
    expect(res.body.disclaimer).toMatch(/deliverab/i);

    // Req 2.4 — persisted with check_type='format'.
    expect(validationResultModel.insert).toHaveBeenCalledTimes(1);
    const arg = validationResultModel.insert.mock.calls[0][0];
    expect(arg.checkType).toBe('format');
    expect(arg.isValid).toBe(true);
    expect(arg.status).toBe('valid');
    expect(arg.e164).toBe('+12025550182');
    expect(arg.rawInput).toBe('(202) 555-0182');
  });

  test('valid international number returns E.164', async () => {
    const { agent, token } = await authedAgent(app);

    const res = await agent
      .post('/validate/single')
      .send({ number: '+442071838750', _csrf: token });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.e164).toBe('+442071838750');
    expect(res.body.country).toBe('GB');
  });

  test('malformed number returns a reason and persists an invalid format row', async () => {
    const { agent, token } = await authedAgent(app);

    const res = await agent
      .post('/validate/single')
      .send({ number: '123', defaultCountry: 'US', _csrf: token });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.label).toBeNull();

    expect(validationResultModel.insert).toHaveBeenCalledTimes(1);
    const arg = validationResultModel.insert.mock.calls[0][0];
    expect(arg.checkType).toBe('format');
    expect(arg.isValid).toBe(false);
    expect(arg.status).toBe('invalid');
  });

  test('requires authentication — unauthenticated POST redirects to /login', async () => {
    // No CSRF token needed to observe the auth redirect; but CSRF runs first in
    // app.js, so send with a valid session-less agent expecting rejection.
    const res = await request(app).post('/validate/single').send({ number: '+12025550182' });
    // Either 403 (CSRF, no token) — the point is it never reaches the handler
    // and never persists a row.
    expect([302, 403]).toContain(res.status);
    expect(validationResultModel.insert).not.toHaveBeenCalled();
  });
});
