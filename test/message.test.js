'use strict';

/**
 * Single message send tests — Requirement 5 (Task 6).
 *
 * The `messages` model and WhatsAppService are mocked so these run without a
 * live MySQL or any network calls; PhoneService (libphonenumber-js) runs for
 * real so the Tier A short-circuit is exercised genuinely. The admin model is
 * mocked to support authenticated sessions (routes are behind requireAuth +
 * CSRF).
 *
 * Coverage:
 *   - template send success → persists { status:'accepted', wamid } (Req 5.4)
 *   - Meta error path → persists { status:'failed', error code/title } (Req 5.5)
 *   - GET /messages/:id/status returns the current stored state (Req 5.6)
 *   - Tier A invalid recipient short-circuits, never calls Meta (Req 5.3)
 *   - buildComponents unit tests (design §5.1 payload shape)
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');

// Mock DB-backed models + the WhatsApp service before requiring the app.
jest.mock('../src/models/admin');
jest.mock('../src/models/message');
jest.mock('../src/services/whatsappService');

const adminModel = require('../src/models/admin');
const messageModel = require('../src/models/message');
const whatsappService = require('../src/services/whatsappService');
const messageController = require('../src/controllers/message');

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

  const page = await agent.get('/messages');
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

// -------------------- buildComponents unit tests --------------------

describe('buildComponents — template body parameters (design §5.1)', () => {
  test('maps non-empty variables to body text parameters', () => {
    const components = messageController.buildComponents(['Alice', 'Order 7']);
    expect(components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Alice' },
          { type: 'text', text: 'Order 7' },
        ],
      },
    ]);
  });

  test('returns [] when there are no variables', () => {
    expect(messageController.buildComponents([])).toEqual([]);
    expect(messageController.buildComponents(undefined)).toEqual([]);
  });

  test('drops blank/whitespace-only variables', () => {
    const components = messageController.buildComponents(['Alice', '', '  ']);
    expect(components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Alice' }] },
    ]);
  });
});

// -------------------- POST /messages/single --------------------

describe('POST /messages/single — template success (Requirement 5.3, 5.4)', () => {
  test('validates Tier A, sends template, persists accepted row with wamid', async () => {
    whatsappService.sendTemplate.mockResolvedValue({
      ok: true,
      wamid: 'wamid.HBgXYZ',
      raw: { messages: [{ id: 'wamid.HBgXYZ' }] },
    });
    messageModel.insert.mockResolvedValue(42);

    const { agent, token } = await authedAgent(app);

    const res = await agent.post('/messages/single').send({
      mode: 'template',
      to: '(202) 555-0182',
      defaultCountry: 'US',
      templateName: 'hello_world',
      language: 'en_US',
      variables: ['Alice'],
      _csrf: token,
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('accepted');
    expect(res.body.wamid).toBe('wamid.HBgXYZ');
    expect(res.body.id).toBe(42);
    expect(res.body.statusUrl).toBe('/messages/42/status');

    // Meta was called with the E.164 recipient + built components.
    expect(whatsappService.sendTemplate).toHaveBeenCalledTimes(1);
    const [to, name, lang, components] = whatsappService.sendTemplate.mock.calls[0];
    expect(to).toBe('+12025550182');
    expect(name).toBe('hello_world');
    expect(lang).toBe('en_US');
    expect(components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Alice' }] },
    ]);

    // Persisted an accepted row with the wamid.
    expect(messageModel.insert).toHaveBeenCalledTimes(1);
    const row = messageModel.insert.mock.calls[0][0];
    expect(row.status).toBe('accepted');
    expect(row.wamid).toBe('wamid.HBgXYZ');
    expect(row.toE164).toBe('+12025550182');
    expect(row.msgType).toBe('template');
    expect(row.templateName).toBe('hello_world');
    expect(row.language).toBe('en_US');
    expect(row.acceptedAt).toBeTruthy();
  });
});

describe('POST /messages/single — Meta error path (Requirement 5.5)', () => {
  test('persists a failed row with the Meta error code/title/detail', async () => {
    whatsappService.sendTemplate.mockResolvedValue({
      ok: false,
      code: '132001',
      title: 'Template does not exist',
      detail: 'template name / language not found',
      raw: {},
    });
    messageModel.insert.mockResolvedValue(99);

    const { agent, token } = await authedAgent(app);

    const res = await agent.post('/messages/single').send({
      mode: 'template',
      to: '+12025550182',
      templateName: 'nope',
      language: 'en_US',
      _csrf: token,
    });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('132001');
    expect(res.body.error.title).toBe('Template does not exist');

    expect(messageModel.insert).toHaveBeenCalledTimes(1);
    const row = messageModel.insert.mock.calls[0][0];
    expect(row.status).toBe('failed');
    expect(row.wamid).toBeNull();
    expect(row.errorCode).toBe('132001');
    expect(row.errorTitle).toBe('Template does not exist');
    expect(row.errorDetail).toBe('template name / language not found');
    expect(row.failedAt).toBeTruthy();
  });
});

describe('POST /messages/single — Tier A short-circuit (Requirement 5.3)', () => {
  test('invalid recipient never calls Meta and never persists a row', async () => {
    const { agent, token } = await authedAgent(app);

    const res = await agent.post('/messages/single').send({
      mode: 'template',
      to: '123',
      defaultCountry: 'US',
      templateName: 'hello_world',
      language: 'en_US',
      _csrf: token,
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.stage).toBe('validation');
    expect(res.body.reason).toBeTruthy();

    expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
    expect(whatsappService.sendText).not.toHaveBeenCalled();
    expect(messageModel.insert).not.toHaveBeenCalled();
  });
});

describe('POST /messages/single — free-text mode (Requirement 5.2)', () => {
  test('sends text and persists accepted row', async () => {
    whatsappService.sendText.mockResolvedValue({
      ok: true,
      wamid: 'wamid.TEXT1',
      raw: {},
    });
    messageModel.insert.mockResolvedValue(7);

    const { agent, token } = await authedAgent(app);

    const res = await agent.post('/messages/single').send({
      mode: 'text',
      to: '+12025550182',
      body: 'Hi there',
      _csrf: token,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('accepted');
    expect(whatsappService.sendText).toHaveBeenCalledWith('+12025550182', 'Hi there');
    const row = messageModel.insert.mock.calls[0][0];
    expect(row.msgType).toBe('text');
    expect(row.bodyPreview).toBe('Hi there');
  });
});

// -------------------- GET /messages/:id/status --------------------

describe('GET /messages/:id/status — status polling (Requirement 5.6)', () => {
  test('returns the current stored state', async () => {
    messageModel.getById.mockResolvedValue({
      id: 42,
      wamid: 'wamid.HBgXYZ',
      to_e164: '+12025550182',
      msg_type: 'template',
      status: 'delivered',
      error_code: null,
      error_title: null,
      error_detail: null,
      accepted_at: '2024-01-01 00:00:00',
      sent_at: '2024-01-01 00:00:01',
      delivered_at: '2024-01-01 00:00:05',
      read_at: null,
      failed_at: null,
    });

    const { agent } = await authedAgent(app);
    const res = await agent.get('/messages/42/status');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(42);
    expect(res.body.status).toBe('delivered');
    expect(res.body.wamid).toBe('wamid.HBgXYZ');
    expect(res.body.timestamps.deliveredAt).toBe('2024-01-01 00:00:05');
    expect(messageModel.getById).toHaveBeenCalledWith('42');
  });

  test('returns 404 for an unknown message id', async () => {
    messageModel.getById.mockResolvedValue(null);

    const { agent } = await authedAgent(app);
    const res = await agent.get('/messages/999/status');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('not_found');
  });
});

// -------------------- auth guard --------------------

describe('routes require authentication', () => {
  test('unauthenticated POST /messages/single never reaches the handler', async () => {
    const res = await request(app)
      .post('/messages/single')
      .send({ mode: 'template', to: '+12025550182' });
    expect([302, 403]).toContain(res.status);
    expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
    expect(messageModel.insert).not.toHaveBeenCalled();
  });
});
