'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_SECRET = 'test-app-secret';

const crypto = require('crypto');
const request = require('supertest');

jest.mock('../src/models/contact');
jest.mock('../src/models/inboundMessage');
jest.mock('../src/models/message');
jest.mock('../src/models/webhookEvent');
jest.mock('../src/services/callbackService');

const contactModel = require('../src/models/contact');
const inboundMessageModel = require('../src/models/inboundMessage');
const messageModel = require('../src/models/message');
const callbackService = require('../src/services/callbackService');
const inbound = require('../src/services/inboundService');
const createApp = require('../src/app');

function webhookBody(messages, contacts = []) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages, contacts } }] }] };
}
const textMsg = (body, extra = {}) => ({ from: '919876543210', id: `wamid.in.${body}`, timestamp: '1761400000', type: 'text', text: { body }, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  inboundMessageModel.insert.mockResolvedValue({ id: 10, duplicate: false });
  messageModel.findRoutingClient.mockResolvedValue(null);
  contactModel.touchInbound.mockResolvedValue();
  contactModel.setOptOut.mockResolvedValue();
});

describe('content + keyword parsing', () => {
  test.each([
    ['STOP', 'opted_out'], ['stop', 'opted_out'], [' Unsubscribe. ', 'opted_out'], ['Stop promotions', 'opted_out'],
    ['START', 'opted_in'], ['please stop calling', null], ['hello', null], [null, null],
  ])('%p → %p', (text, expected) => {
    expect(inbound.detectOptAction(text)).toBe(expected);
  });

  test('extracts text from buttons, interactive replies, and media captions', () => {
    expect(inbound.extractContent({ type: 'button', button: { text: 'Confirm', payload: 'C' } }).text).toBe('Confirm');
    expect(inbound.extractContent({ type: 'interactive', interactive: { button_reply: { id: 'y', title: 'Yes' } } }).text).toBe('Yes');
    expect(inbound.extractContent({ type: 'image', image: { id: 'MEDIA1', caption: 'receipt' } })).toEqual({ text: 'receipt', mediaId: 'MEDIA1' });
  });

  test('normalizes Meta wa_id to E.164', () => {
    expect(inbound.toE164('919876543210')).toBe('+919876543210');
  });
});

describe('handleOne', () => {
  test('stores the message, opens the 24h window, picks up the contact name', async () => {
    await inbound.processWebhook(webhookBody([textMsg('hi')], [{ wa_id: '919876543210', profile: { name: 'Asha' } }]));
    expect(inboundMessageModel.insert).toHaveBeenCalledWith(expect.objectContaining({
      wamid: 'wamid.in.hi', fromE164: '+919876543210', contactName: 'Asha', msgType: 'text', textBody: 'hi',
      receivedAt: '2025-10-25 13:46:40',
    }));
    expect(contactModel.touchInbound).toHaveBeenCalledWith('+919876543210', { name: 'Asha', at: '2025-10-25 13:46:40' });
    expect(contactModel.setOptOut).not.toHaveBeenCalled();
    expect(callbackService.enqueue).not.toHaveBeenCalled(); // no project to route to
  });

  test('STOP opts the contact out; START opts back in', async () => {
    await inbound.processWebhook(webhookBody([textMsg('STOP')]));
    expect(contactModel.setOptOut).toHaveBeenCalledWith('+919876543210', true);
    await inbound.processWebhook(webhookBody([textMsg('START')]));
    expect(contactModel.setOptOut).toHaveBeenLastCalledWith('+919876543210', false);
  });

  test('a reply to a project message is routed to that project with its reference', async () => {
    messageModel.findRoutingClient.mockResolvedValue({ apiClientId: 7, messageId: 123, reference: 'order-1042' });
    await inbound.processWebhook(webhookBody([textMsg('yes', { context: { from: 'x', id: 'wamid.out.1' } })]));
    expect(messageModel.findRoutingClient).toHaveBeenCalledWith({ contextWamid: 'wamid.out.1', fromE164: '+919876543210' });
    expect(inboundMessageModel.insert).toHaveBeenCalledWith(expect.objectContaining({ apiClientId: 7, contextWamid: 'wamid.out.1' }));
    expect(callbackService.enqueue).toHaveBeenCalledWith(7, 'message.received', expect.objectContaining({
      from: '+919876543210', text: 'yes', replyTo: { wamid: 'wamid.out.1', messageId: 123, reference: 'order-1042' },
    }));
  });

  test('duplicate deliveries from Meta are ignored', async () => {
    inboundMessageModel.insert.mockResolvedValue({ id: null, duplicate: true });
    messageModel.findRoutingClient.mockResolvedValue({ apiClientId: 7 });
    const [r] = await inbound.processWebhook(webhookBody([textMsg('STOP')]));
    expect(r).toEqual({ duplicate: true });
    expect(contactModel.setOptOut).not.toHaveBeenCalled();
    expect(callbackService.enqueue).not.toHaveBeenCalled();
  });

  test('one bad message does not stop the rest', async () => {
    inboundMessageModel.insert.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ id: 11, duplicate: false });
    const results = await inbound.processWebhook(webhookBody([textMsg('a'), textMsg('b')]));
    expect(results[0].error).toBe('db down');
    expect(results[1].id).toBe(11);
  });
});

describe('POST /webhook with customer messages', () => {
  test('signed inbound callback is processed and acked 200', async () => {
    const raw = JSON.stringify(webhookBody([textMsg('hello')]));
    const sig = 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex');
    const res = await request(createApp()).post('/webhook')
      .set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(raw);
    expect(res.status).toBe(200);
    expect(inboundMessageModel.insert).toHaveBeenCalledWith(expect.objectContaining({ textBody: 'hello' }));
  });
});
