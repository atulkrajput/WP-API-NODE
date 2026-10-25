'use strict';

process.env.NODE_ENV = 'test';

jest.mock('../src/models/apiClient');
jest.mock('../src/models/callbackDelivery');
jest.mock('../src/models/message');

const apiClientModel = require('../src/models/apiClient');
const callbackDeliveryModel = require('../src/models/callbackDelivery');
const messageModel = require('../src/models/message');
const cb = require('../src/services/callbackService');

beforeEach(() => jest.clearAllMocks());

describe('signatures', () => {
  test('sign/verify round trip; tampering and stale timestamps fail', () => {
    const body = '{"a":1}';
    const header = cb.sign('whsec_x', body);
    expect(cb.verify('whsec_x', body, header)).toBe(true);
    expect(cb.verify('whsec_x', '{"a":2}', header)).toBe(false);
    expect(cb.verify('wrong', body, header)).toBe(false);
    const old = cb.sign('whsec_x', body, Math.floor(Date.now() / 1000) - 3600);
    expect(cb.verify('whsec_x', body, old)).toBe(false);
  });
});

describe('enqueue', () => {
  test('no-op when the project has no callback URL', async () => {
    apiClientModel.getCallback.mockResolvedValue({ id: 7, is_active: 1, callback_url: null });
    expect(await cb.enqueue(7, 'ping', {})).toBeNull();
    expect(callbackDeliveryModel.enqueue).not.toHaveBeenCalled();
  });

  test('stores a JSON body with event id, type, and data', async () => {
    apiClientModel.getCallback.mockResolvedValue({ id: 7, is_active: 1, callback_url: 'https://x.test/hook' });
    callbackDeliveryModel.enqueue.mockResolvedValue(5);
    expect(await cb.enqueue(7, 'ping', { hello: 1 })).toBe(5);
    const { payload } = callbackDeliveryModel.enqueue.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({ event: 'ping', data: { hello: 1 } });
    expect(parsed.id).toMatch(/^evt_/);
  });

  test('never throws (webhook handlers depend on that)', async () => {
    apiClientModel.getCallback.mockRejectedValue(new Error('db down'));
    await expect(cb.enqueue(7, 'ping', {})).resolves.toBeNull();
  });

  test('status change is only forwarded for API-originated messages', async () => {
    messageModel.findForCallback.mockResolvedValue({ id: 1, wamid: 'w', api_client_id: null });
    await cb.onStatusChange('w');
    expect(apiClientModel.getCallback).not.toHaveBeenCalled();

    messageModel.findForCallback.mockResolvedValue({ id: 1, wamid: 'w', api_client_id: 7, status: 'delivered', to_e164: '+1' });
    apiClientModel.getCallback.mockResolvedValue({ id: 7, is_active: 1, callback_url: 'https://x.test' });
    callbackDeliveryModel.enqueue.mockResolvedValue(9);
    await cb.onStatusChange('w');
    const body = JSON.parse(callbackDeliveryModel.enqueue.mock.calls[0][0].payload);
    expect(body).toMatchObject({ event: 'message.status', data: { id: 1, status: 'delivered' } });
  });
});

describe('deliver', () => {
  const row = { id: 3, event: 'ping', payload: '{"x":1}', attempts: 0, callback_url: 'https://x.test', callback_secret: 's', is_active: 1 };

  test('2xx → delivered, body sent byte-for-byte with a valid signature', async () => {
    const http = { post: jest.fn().mockResolvedValue({ status: 204 }) };
    expect(await cb.deliver(row, http)).toBe('delivered');
    const [url, body, opts] = http.post.mock.calls[0];
    expect(url).toBe('https://x.test');
    expect(body).toBe('{"x":1}');
    expect(cb.verify('s', body, opts.headers['X-WAHub-Signature'])).toBe(true);
    expect(opts.headers['X-WAHub-Event']).toBe('ping');
    expect(callbackDeliveryModel.markDelivered).toHaveBeenCalledWith(3, 204);
  });

  test('non-2xx → retried later with backoff', async () => {
    const http = { post: jest.fn().mockResolvedValue({ status: 500 }) };
    expect(await cb.deliver(row, http)).toBe('failed');
    const [, info] = callbackDeliveryModel.markAttemptFailed.mock.calls[0];
    expect(info.code).toBe(500);
    expect(info.nextAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  test('gives up after the last attempt', async () => {
    const http = { post: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNABORTED' })) };
    await cb.deliver({ ...row, attempts: cb.MAX_ATTEMPTS - 1 }, http);
    const [, info] = callbackDeliveryModel.markAttemptFailed.mock.calls[0];
    expect(info.nextAttemptAt).toBeNull();
    expect(info.error).toMatch(/Timed out/);
  });

  test('revoked project is not called', async () => {
    const http = { post: jest.fn() };
    await cb.deliver({ ...row, is_active: 0 }, http);
    expect(http.post).not.toHaveBeenCalled();
  });
});
