'use strict';

/**
 * WhatsAppService tests — Requirements 5 & 3 (design §5).
 *
 * axios is fully mocked so no real network calls are made. We assert:
 *   - sendTemplate / sendText build the correct Cloud API payloads;
 *   - a success response is normalized to { ok:true, wamid, raw };
 *   - a Meta error payload (design §5.3) is normalized to
 *     { ok:false, code, title, detail };
 *   - a timeout (ECONNABORTED) and a plain network error are handled without
 *     throwing and without leaking the bearer token.
 */

process.env.NODE_ENV = 'test';

// Mock axios: the service calls axios.create(...) once, then .post() per send.
const mockPost = jest.fn();
const mockCreate = jest.fn(() => ({ post: mockPost }));

jest.mock('axios', () => ({
  create: (...args) => mockCreate(...args),
}));

const config = require('../src/config');
const whatsappService = require('../src/services/whatsappService');

beforeEach(() => {
  jest.clearAllMocks();
});

// -------------------- client construction --------------------

describe('axios instance construction (design §5)', () => {
  test('builds base URL from graphVersion + phoneNumberId and sets bearer token', () => {
    const meta = {
      baseUrl: 'https://graph.facebook.com',
      graphVersion: 'v21.0',
      phoneNumberId: '123456789',
      token: 'SECRET_TOKEN',
      timeoutMs: 15000,
    };

    whatsappService.buildClient(meta);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const cfg = mockCreate.mock.calls[0][0];
    expect(cfg.baseURL).toBe('https://graph.facebook.com/v21.0/123456789');
    expect(cfg.timeout).toBe(15000);
    expect(cfg.headers.Authorization).toBe('Bearer SECRET_TOKEN');
    expect(cfg.headers['Content-Type']).toBe('application/json');
  });
});

// -------------------- sendTemplate --------------------

describe('sendTemplate — Requirement 5.1 / 3 (design §5.1)', () => {
  test('posts a well-formed template payload and normalizes success → wamid', async () => {
    mockPost.mockResolvedValueOnce({
      data: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.HBgABC123' }] },
    });

    const components = [
      { type: 'body', parameters: [{ type: 'text', text: 'Alice' }] },
    ];
    const result = await whatsappService.sendTemplate(
      '15551234567',
      'hello_world',
      'en_US',
      components
    );

    // payload correctness
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, payload] = mockPost.mock.calls[0];
    expect(path).toBe('/messages');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'template',
      template: {
        name: 'hello_world',
        language: { code: 'en_US' },
        components,
      },
    });

    // normalized success
    expect(result.ok).toBe(true);
    expect(result.wamid).toBe('wamid.HBgABC123');
    expect(result.raw).toEqual({
      messaging_product: 'whatsapp',
      messages: [{ id: 'wamid.HBgABC123' }],
    });
  });

  test('omits components from payload when none are supplied', async () => {
    mockPost.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.X' }] } });

    await whatsappService.sendTemplate('15551234567', 'hello_world', 'en_US');

    const payload = mockPost.mock.calls[0][1];
    expect(payload.template.components).toBeUndefined();
    expect(payload.template).toEqual({
      name: 'hello_world',
      language: { code: 'en_US' },
    });
  });

  test('normalizes a Meta error payload → { ok:false, code, title, detail } (design §5.3)', async () => {
    mockPost.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error: {
            message: 'Template does not exist',
            code: 132001,
            error_data: { details: 'template name / language not found' },
            fbtrace_id: 'Axxxx',
          },
        },
      },
    });

    const result = await whatsappService.sendTemplate('15551234567', 'nope', 'en_US');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('132001');
    expect(result.title).toBe('Template does not exist');
    expect(result.detail).toBe('template name / language not found');
    expect(result.wamid).toBeUndefined();
  });

  test('falls back to error.message for detail when error_data.details is absent', async () => {
    mockPost.mockRejectedValueOnce({
      response: {
        data: {
          error: { message: 'Invalid parameter', code: 100 },
        },
      },
    });

    const result = await whatsappService.sendTemplate('15551234567', 'x', 'en_US');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('100');
    expect(result.title).toBe('Invalid parameter');
    expect(result.detail).toBe('Invalid parameter');
  });
});

// -------------------- sendText --------------------

describe('sendText — Requirement 5.2 (design §5.2)', () => {
  test('posts a well-formed text payload and normalizes success', async () => {
    mockPost.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.TEXT1' }] } });

    const result = await whatsappService.sendText('15551234567', 'Hi there');

    const [path, payload] = mockPost.mock.calls[0];
    expect(path).toBe('/messages');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'Hi there' },
    });

    expect(result.ok).toBe(true);
    expect(result.wamid).toBe('wamid.TEXT1');
  });

  test('normalizes a Meta error on a text send', async () => {
    mockPost.mockRejectedValueOnce({
      response: {
        data: {
          error: {
            message: 'Outside 24h window',
            code: 131047,
            error_data: { details: 'Re-engagement message' },
          },
        },
      },
    });

    const result = await whatsappService.sendText('15551234567', 'Hi');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('131047');
    expect(result.title).toBe('Outside 24h window');
    expect(result.detail).toBe('Re-engagement message');
  });
});

// -------------------- network / timeout handling (NFR-2) --------------------

describe('network & timeout handling (NFR-2)', () => {
  test('timeout (ECONNABORTED) is normalized without throwing', async () => {
    mockPost.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' });

    const result = await whatsappService.sendText('15551234567', 'Hi');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ETIMEDOUT');
    expect(result.title).toMatch(/timed out/i);
    expect(result.detail).toContain(String(config.meta.timeoutMs));
  });

  test('generic network error (no response) is normalized', async () => {
    mockPost.mockRejectedValueOnce({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });

    const result = await whatsappService.sendTemplate('15551234567', 'hello_world', 'en_US');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ECONNREFUSED');
    expect(result.title).toMatch(/could not reach/i);
    expect(result.detail).toBeTruthy();
  });

  test('normalized failures never leak the bearer token', async () => {
    mockPost.mockRejectedValueOnce({
      response: { data: { error: { message: 'boom', code: 1 } } },
    });

    const result = await whatsappService.sendTemplate('15551234567', 'x', 'en_US');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/Bearer/i);
    expect(serialized).not.toContain(config.meta.token || 'NO_TOKEN_SET_XYZ');
  });
});
