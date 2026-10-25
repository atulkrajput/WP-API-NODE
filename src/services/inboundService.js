'use strict';

/**
 * InboundService — handles customer messages from the Meta webhook
 * (`entry[].changes[].value.messages[]`).
 *
 * For each message:
 *   1. store it (deduped on wamid — Meta retries),
 *   2. open the contact's 24h customer-service window,
 *   3. apply STOP / START opt-out keywords,
 *   4. route it to a project (the one whose message was replied to, else the
 *      one that last messaged this number) and queue a `message.received`
 *      callback.
 */

const config = require('../config');
const contactModel = require('../models/contact');
const inboundMessageModel = require('../models/inboundMessage');
const messageModel = require('../models/message');
const callbackService = require('./callbackService');

const OPT_OUT_WORDS = new Set([
  'STOP', 'STOP ALL', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'OPT OUT', 'OPTOUT', 'OPT-OUT', 'STOP PROMOTIONS',
]);
const OPT_IN_WORDS = new Set(['START', 'UNSTOP', 'SUBSCRIBE', 'OPT IN', 'OPTIN', 'OPT-IN', 'RESUME']);

function log(event, fields) {
  if (config.env === 'test') return;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function toUtc(unixSeconds) {
  const n = Number(unixSeconds);
  const d = Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Meta sends `from` as digits without "+". */
function toE164(waId) {
  const digits = String(waId || '').replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

/**
 * Pull the human-meaningful content out of any message type.
 * @returns {{ text: string|null, mediaId: string|null }}
 */
function extractContent(msg) {
  const t = msg.type;
  const part = msg[t] || {};
  switch (t) {
    case 'text':
      return { text: part.body || null, mediaId: null };
    case 'button':
      return { text: part.text || part.payload || null, mediaId: null };
    case 'interactive': {
      const r = part.button_reply || part.list_reply || part.nfm_reply || {};
      return { text: r.title || r.id || r.body || null, mediaId: null };
    }
    case 'image': case 'video': case 'document': case 'audio': case 'sticker':
      return { text: part.caption || part.filename || null, mediaId: part.id || null };
    case 'location':
      return {
        text: [part.name, part.address, part.latitude != null ? `${part.latitude},${part.longitude}` : null]
          .filter(Boolean).join(' — ') || null,
        mediaId: null,
      };
    case 'reaction':
      return { text: part.emoji ? `reacted ${part.emoji}` : 'removed reaction', mediaId: null };
    default:
      return { text: null, mediaId: null };
  }
}

/** 'opted_out' | 'opted_in' | null from the message text. */
function detectOptAction(text) {
  if (!text) return null;
  const word = String(text).trim().toUpperCase().replace(/[.!]+$/, '');
  if (OPT_OUT_WORDS.has(word)) return 'opted_out';
  if (OPT_IN_WORDS.has(word)) return 'opted_in';
  return null;
}

/** Collect [{ msg, name }] from a webhook body. */
function extractMessages(body) {
  const out = [];
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  for (const entry of entries) {
    for (const change of (entry && Array.isArray(entry.changes) ? entry.changes : [])) {
      const value = (change && change.value) || {};
      const names = {};
      (Array.isArray(value.contacts) ? value.contacts : []).forEach((c) => {
        if (c && c.wa_id) names[c.wa_id] = c.profile && c.profile.name;
      });
      (Array.isArray(value.messages) ? value.messages : []).forEach((msg) => {
        if (msg && msg.id && msg.from) out.push({ msg, name: names[msg.from] || null });
      });
    }
  }
  return out;
}

/** Process one inbound message. Returns a short outcome for logging/tests. */
async function handleOne({ msg, name }) {
  const fromE164 = toE164(msg.from);
  if (!fromE164) return { skipped: 'no_from' };
  const receivedAt = toUtc(msg.timestamp);
  const { text, mediaId } = extractContent(msg);
  const contextWamid = (msg.context && msg.context.id) || null;
  // Reactions point at a message too; treat that as the context.
  const ctx = contextWamid || (msg.type === 'reaction' && msg.reaction && msg.reaction.message_id) || null;
  const optAction = msg.type === 'reaction' ? null : detectOptAction(text);

  const route = await messageModel.findRoutingClient({ contextWamid: ctx, fromE164 });

  const stored = await inboundMessageModel.insert({
    wamid: msg.id,
    fromE164,
    contactName: name,
    msgType: msg.type || 'unknown',
    textBody: text,
    mediaId,
    contextWamid: ctx,
    optAction,
    apiClientId: route ? route.apiClientId : null,
    payload: msg,
    receivedAt,
  });
  if (stored.duplicate) return { duplicate: true };

  // Any inbound message opens/extends the 24h window.
  await contactModel.touchInbound(fromE164, { name, at: receivedAt });
  if (optAction) {
    await contactModel.setOptOut(fromE164, optAction === 'opted_out');
    log('inbound.opt_change', { from: fromE164, action: optAction });
  }

  if (route) {
    await callbackService.enqueue(route.apiClientId, 'message.received', {
      id: stored.id,
      wamid: msg.id,
      from: fromE164,
      name,
      type: msg.type,
      text,
      mediaId,
      optAction,
      replyTo: ctx ? { wamid: ctx, messageId: route.messageId, reference: route.reference } : null,
      receivedAt,
    });
  }

  log('inbound.stored', { id: stored.id, from: fromE164, type: msg.type, routedTo: route ? route.apiClientId : null });
  return { id: stored.id, optAction, routedTo: route ? route.apiClientId : null };
}

/** Process every inbound message in a webhook body; per-message isolation. */
async function processWebhook(body) {
  const results = [];
  for (const item of extractMessages(body)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await handleOne(item));
    } catch (err) {
      log('inbound.error', { wamid: item.msg.id, error: err.message });
      results.push({ error: err.message });
    }
  }
  return results;
}

module.exports = {
  processWebhook, handleOne, extractMessages, extractContent, detectOptAction, toE164,
};
