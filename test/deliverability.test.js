'use strict';

/**
 * Deliverability (Tier B) tests — Requirement 3 (Task 7).
 *
 * The `validation_results` model and WhatsAppService are mocked so these run
 * without a live MySQL or any network calls; PhoneService (libphonenumber-js)
 * runs for real so the Tier A short-circuit is exercised genuinely. The admin
 * model is mocked to support authenticated sessions (the route is behind
 * requireAuth + CSRF).
 *
 * Coverage:
 *   - valid number → probe accepted → persists { check_type:'deliverability',
 *     status:'accepted', wamid } and returns the wamid (Req 3.2, 3.3)
 *   - invalid format short-circuits: NEVER calls Meta, persists an
 *     invalid deliverability row (Req 3.1)
 *   - Meta reject → persists { check_type:'deliverability', status:'failed' }
 *     with the Meta error code/message (Req 3.4)
 *   - probe uses the configured PROBE_TEMPLATE name/lang (Req 3.2)
 *   - responses carry the async-webhook disclaimer (Req 3.5)
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.PROBE_TEMPLATE_NAME = 'probe_ping';
process.env.PROBE_TEMPLATE_LANG = 'en_US';

const request = require('supertest');
const bcrypt = require('bcryptjs');

// Mock DB-backed models + the WhatsApp service before requiring the app.
jest.mock('../src/models/admin');
jest.mock('../src/models/validationResult');
jest.mock('../src/services/whatsappService');

const adminModel = require('../src/models/admin');
const validationResultModel = require('../src/models/validationResult');
const whatsappService = require('../src/services/whatsappService');

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

  const page = await agent.get('/validate');
  return { agent, token: extractCsrf(page.text) };
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

// -------------------- accepted probe (Req 3.2, 3.3) --------------------

describe('POST /validate/deliverability — probe accepted (Requirement 3.2, 3.3)', () => {
  test('valid number → sends probe template, persists accepted + wamid', async () => {
    whatsappService.sendTemplate.mockResolvedValue({
      ok: true,
      wamid: 'wamid.PROBE1',
      raw: { messages: [{ id: 'wamid.PROBE1' }] },
    });
    validationResultModel.insert.mockResolvedValue(55);

    const { agent, token } = await authedAgent(app);

    const res = await agent
      .post('/validate/deliverability')
      .send({ number: '(202) 555-0182', defaultCountry: 'US', _csrf: token });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.tier).toBe('B');
    expect(res.body.status).toBe('accepted');
    expect(res.body.wamid).toBe('wamid.PROBE1');
    expect(res.body.label).toMatch(/Tier B/i);
    // Req 3.5 — makes clear final status arrives asynchronously via webhook.
    expect(res.body.disclaimer).toMatch(/webhook/i);

    // Req 3.2 — a real send was attempted using the configured probe template.
    expect(whatsappService.sendTemplate).toHaveBeenCalledTimes(1);
    const [to, name, lang] = whatsappService.sendTemplate.mock.calls[0];
    expect(to).toBe('+12025550182');
    expect(name).toBe('probe_ping');
    expect(lang).toBe('en_US');

    // Req 3.3 — persisted deliverability/accepted with the wamid.
    expect(validationResultModel.insert).toHaveBeenCalledTimes(1);
    const row = validationResultModel.insert.mock.calls[0][0];
    expect(row.checkType).toBe('deliverability');
    expect(row.status).toBe('accepted');
    expect(row.isValid).toBe(true);
    expect(row.wamid).toBe('wamid.PROBE1');
    expect(row.e164).toBe('+12025550182');
  });
});

// -------------------- Tier A short-circuit (Req 3.1) --------------------

describe('POST /validate/deliverability — Tier A short-circuit (Requirement 3.1)', () => {
  test('invalid format never calls Meta and reports the format error', async () => {
    const { agent, token } = await authedAgent(app);

    const res = await agent
      .post('/validate/deliverability')
      .send({ number: '123', defaultCountry: 'US', _csrf: token });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.tier).toBe('B');
    expect(res.body.stage).toBe('format');
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBeTruthy();

    // Req 3.1 — Meta is NEVER called on an invalid format.
    expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
    expect(whatsappService.sendText).not.toHaveBeenCalled();

    // The invalid probe is still auditable as a deliverability attempt.
    expect(validationResultModel.insert).toHaveBeenCalledTimes(1);
    const row = validationResultModel.insert.mock.calls[0][0];
    expect(row.checkType).toBe('deliverability');
    expect(row.status).toBe('invalid');
    expect(row.isValid).toBe(false);
    expect(row.wamid).toBeNull();
  });
});

// -------------------- Meta reject (Req 3.4) --------------------

describe('POST /validate/deliverability — Meta rejection (Requirement 3.4)', () => {
  test('valid format but Meta rejects → persists failed with error code/message', async () => {
    whatsappService.sendTemplate.mockResolvedValue({
      ok: false,
      code: '131030',
      title: 'Recipient not in allowed list',
      detail: 'This number cannot receive messages right now.',
      raw: {},
    });
    validationResultModel.insert.mockResolvedValue(77);

    const { agent, token } = await authedAgent(app);

    const res = await agent
      .post('/validate/deliverability')
      .send({ number: '+12025550182', _csrf: token });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.tier).toBe('B');
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('131030');
    expect(res.body.error.title).toBe('Recipient not in allowed list');
    expect(res.body.disclaimer).toMatch(/webhook/i);

    // A real send was attempted (format was valid).
    expect(whatsappService.sendTemplate).toHaveBeenCalledTimes(1);

    // Req 3.4 — persisted deliverability/failed with the Meta error info.
    expect(validationResultModel.insert).toHaveBeenCalledTimes(1);
    const row = validationResultModel.insert.mock.calls[0][0];
    expect(row.checkType).toBe('deliverability');
    expect(row.status).toBe('failed');
    expect(row.isValid).toBe(true);
    expect(row.wamid).toBeNull();
    expect(row.reason).toBe('This number cannot receive messages right now.');
  });
});

// -------------------- auth guard --------------------

describe('POST /validate/deliverability requires authentication', () => {
  test('unauthenticated request never reaches the handler or calls Meta', async () => {
    const res = await request(app)
      .post('/validate/deliverability')
      .send({ number: '+12025550182' });
    expect([302, 403]).toContain(res.status);
    expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
    expect(validationResultModel.insert).not.toHaveBeenCalled();
  });
});
