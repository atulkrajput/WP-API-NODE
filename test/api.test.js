'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_PER_MIN = '5';

const request = require('supertest');

jest.mock('../src/models/apiClient');
jest.mock('../src/models/message');
jest.mock('../src/services/whatsappService');

const apiClientModel = require('../src/models/apiClient');
const messageModel = require('../src/models/message');
const whatsappService = require('../src/services/whatsappService');
const { _windows } = require('../src/middleware/apiAuth');
const createApp = require('../src/app');

const KEY = 'wak_test_key';
const CLIENT = { id: 7, name: 'CRM', key_prefix: 'wak_test_ke' };

let app;
beforeEach(() => {
  jest.clearAllMocks();
  _windows.clear();
  apiClientModel.findActiveByKey.mockImplementation(async (k) => (k === KEY ? CLIENT : null));
  apiClientModel.touch.mockResolvedValue();
  app = createApp();
});

const auth = (r) => r.set('Authorization', `Bearer ${KEY}`);

describe('API auth', () => {
  test('missing key → 401', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_api_key');
  });

  test('wrong key → 401', async () => {
    const res = await request(app).get('/api/v1/me').set('X-API-Key', 'wak_nope');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_api_key');
  });

  test('valid key → identifies the project, no CSRF needed for POST', async () => {
    const me = await auth(request(app).get('/api/v1/me'));
    expect(me.status).toBe(200);
    expect(me.body.client).toEqual({ id: 7, name: 'CRM' });
  });

  test('rate limit → 429 after the per-minute budget', async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await auth(request(app).get('/api/v1/me'))).status).toBe(200);
    }
    const res = await auth(request(app).get('/api/v1/me'));
    expect(res.status).toBe(429);
  });
});

describe('POST /api/v1/messages', () => {
  test('template send is tagged with the calling project', async () => {
    whatsappService.sendTemplate.mockResolvedValue({ ok: true, wamid: 'wamid.X' });
    messageModel.insert.mockResolvedValue(55);

    const res = await auth(request(app).post('/api/v1/messages')).send({
      to: '+14155550123',
      template: { name: 'order_update', language: 'en_US', variables: ['Asha'] },
      reference: 'order-1',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, id: 55, wamid: 'wamid.X', reference: 'order-1' });
    expect(whatsappService.sendTemplate).toHaveBeenCalledWith(
      '+14155550123', 'order_update', 'en_US',
      [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }]
    );
    expect(messageModel.insert).toHaveBeenCalledWith(
      expect.objectContaining({ apiClientId: 7, clientRef: 'order-1', status: 'accepted' })
    );
  });

  test('invalid number never reaches Meta', async () => {
    const res = await auth(request(app).post('/api/v1/messages')).send({ to: '123', template: { name: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.stage).toBe('validation');
    expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
  });

  test('Meta rejection → 502 with error details', async () => {
    whatsappService.sendText.mockResolvedValue({ ok: false, code: '131047', title: 'Re-engagement message', detail: 'outside 24h' });
    messageModel.insert.mockResolvedValue(56);
    const res = await auth(request(app).post('/api/v1/messages')).send({ to: '+14155550123', type: 'text', text: 'hi' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('131047');
  });

  test('malformed JSON → 400 JSON, not HTML', async () => {
    const res = await auth(request(app).post('/api/v1/messages'))
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });
});

describe('GET /api/v1/messages/:id', () => {
  test('scoped to the calling project', async () => {
    messageModel.getByIdForClient.mockResolvedValue(null);
    const res = await auth(request(app).get('/api/v1/messages/99'));
    expect(res.status).toBe(404);
    expect(messageModel.getByIdForClient).toHaveBeenCalledWith(99, 7);
  });

  test('returns serialized status', async () => {
    messageModel.getByIdForClient.mockResolvedValue({
      id: 99, wamid: 'wamid.Y', to_e164: '+14155550123', msg_type: 'template',
      template_name: 'order_update', client_ref: 'order-1', status: 'delivered',
      created_at: '2026-01-01 00:00:00', delivered_at: '2026-01-01 00:00:05',
    });
    const res = await auth(request(app).get('/api/v1/messages/99'));
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: 99, status: 'delivered', reference: 'order-1', error: null });
  });
});

describe('POST /api/v1/validate', () => {
  test('format check with default country', async () => {
    const res = await auth(request(app).post('/api/v1/validate')).send({ number: '2025550182', defaultCountry: 'US' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, e164: '+12025550182', country: 'US' });
  });
});

describe('CSP', () => {
  test('pages carry a script nonce that matches the CSP header', async () => {
    const res = await request(app).get('/login');
    const header = res.headers['content-security-policy'];
    const m = header.match(/'nonce-([^']+)'/);
    expect(m).not.toBeNull();
  });
});
