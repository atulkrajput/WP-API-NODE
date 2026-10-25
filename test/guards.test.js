'use strict';

process.env.NODE_ENV = 'test';

jest.mock('../src/models/contact');
jest.mock('../src/models/message');
jest.mock('../src/services/whatsappService');

const contactModel = require('../src/models/contact');
const messageModel = require('../src/models/message');
const whatsappService = require('../src/services/whatsappService');
const { sendOne } = require('../src/services/messageService');
const { callbackUrlError } = require('../src/controllers/apiKeys');

beforeEach(() => {
  jest.clearAllMocks();
  messageModel.insert.mockResolvedValue(1);
  whatsappService.sendText.mockResolvedValue({ ok: true, wamid: 'w' });
  whatsappService.sendTemplate.mockResolvedValue({ ok: true, wamid: 'w' });
});

const TO = '+14155550123';

test('opted-out recipient → 409, Meta never called', async () => {
  contactModel.getState.mockResolvedValue({ optedOut: true, sessionOpen: true });
  const r = await sendOne({ mode: 'template', to: TO, templateName: 'x', language: 'en_US' });
  expect(r.status).toBe(409);
  expect(r.body.error).toBe('recipient_opted_out');
  expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
});

test('free text outside the 24h window → 409 with a clear reason', async () => {
  contactModel.getState.mockResolvedValue({ optedOut: false, sessionOpen: false, lastInboundAt: null });
  const r = await sendOne({ mode: 'text', to: TO, body: 'hi' });
  expect(r.status).toBe(409);
  expect(r.body.error).toBe('outside_session_window');
  expect(whatsappService.sendText).not.toHaveBeenCalled();
});

test('templates still go out when the window is closed', async () => {
  contactModel.getState.mockResolvedValue({ optedOut: false, sessionOpen: false });
  const r = await sendOne({ mode: 'template', to: TO, templateName: 'x', language: 'en_US' });
  expect(r.status).toBe(201);
});

test('free text inside the window is sent', async () => {
  contactModel.getState.mockResolvedValue({ optedOut: false, sessionOpen: true });
  const r = await sendOne({ mode: 'text', to: TO, body: 'hi' });
  expect(r.status).toBe(201);
});

test('contact lookup failure fails open (Meta still enforces policy)', async () => {
  contactModel.getState.mockRejectedValue(new Error('db down'));
  const r = await sendOne({ mode: 'text', to: TO, body: 'hi' });
  expect(r.status).toBe(201);
});

test('callback URL validation', () => {
  expect(callbackUrlError('https://a.test/hook')).toBeNull();
  expect(callbackUrlError('ftp://a.test')).toMatch(/https/);
  expect(callbackUrlError('not a url')).toMatch(/valid/);
});
