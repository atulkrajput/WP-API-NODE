'use strict';

/**
 * CallbackService — pushes events to each project's callback URL.
 *
 * Events:
 *   message.status    an outbound message the project sent changed status
 *   message.received  a customer replied (routed to the project that last
 *                     messaged them, or whose message they replied to)
 *   ping              test event from the admin UI
 *
 * Delivery is at-least-once via the `callback_deliveries` outbox: enqueue is
 * a DB insert, a dispatcher loop POSTs due rows and retries failures with
 * backoff (30s, 2m, 10m, 1h, 6h, then gives up). Projects should dedupe on
 * the `id` field of the body.
 *
 * Signature (Stripe-style, prevents replay):
 *   X-WAHub-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 */

const crypto = require('crypto');
const axios = require('axios');

const config = require('../config');
const apiClientModel = require('../models/apiClient');
const callbackDeliveryModel = require('../models/callbackDelivery');
const messageModel = require('../models/message');

const BACKOFF_MS = [30e3, 120e3, 600e3, 3600e3, 6 * 3600e3];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

function log(event, fields) {
  if (config.env === 'test') return;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function utc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Build the signature header value. */
function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', String(secret)).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/**
 * Verify a signature header (exported so the docs/tests show the exact
 * algorithm a project should implement).
 */
function verify(secret, body, header, toleranceSec = 300, now = Date.now()) {
  const parts = Object.fromEntries(
    String(header || '').split(',').map((kv) => kv.split('=').map((x) => x.trim()))
  );
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = sign(secret, body, t).split('v1=')[1];
  const a = Buffer.from(parts.v1);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Queue an event for a project. No-op when the project has no callback URL
 * or is revoked. Never throws (callers are webhook handlers).
 */
async function enqueue(apiClientId, event, data) {
  try {
    if (!apiClientId) return null;
    const client = await apiClientModel.getCallback(apiClientId);
    if (!client || !client.is_active || !client.callback_url) return null;
    const body = JSON.stringify({
      id: `evt_${crypto.randomBytes(12).toString('hex')}`,
      event,
      createdAt: new Date().toISOString(),
      data,
    });
    const id = await callbackDeliveryModel.enqueue({ apiClientId, event, payload: body });
    log('callback.enqueued', { deliveryId: id, apiClientId, event });
    return id;
  } catch (err) {
    log('callback.enqueue_error', { apiClientId, event, error: err.message });
    return null;
  }
}

/** Outbound status changed → notify the project that sent it. */
async function onStatusChange(wamid) {
  try {
    const row = await messageModel.findForCallback(wamid);
    if (!row || !row.api_client_id) return null;
    // Lazy require avoids a cycle (messageService → … → callbackService).
    // eslint-disable-next-line global-require
    const { serialize } = require('./messageService');
    return enqueue(row.api_client_id, 'message.status', serialize(row));
  } catch (err) {
    log('callback.status_error', { wamid, error: err.message });
    return null;
  }
}

/** POST one claimed delivery and record the outcome. */
async function deliver(row, http = axios) {
  const attemptNo = (Number(row.attempts) || 0) + 1;
  const fail = async (error, code = null) => {
    const nextAttemptAt = attemptNo < MAX_ATTEMPTS ? utc(Date.now() + BACKOFF_MS[attemptNo - 1]) : null;
    await callbackDeliveryModel.markAttemptFailed(row.id, { code, error, nextAttemptAt });
    log('callback.failed', { deliveryId: row.id, attempt: attemptNo, code, error, willRetry: Boolean(nextAttemptAt) });
    return 'failed';
  };

  if (!row.is_active) return fail('Project key revoked');
  if (!row.callback_url) return fail('No callback URL configured');

  try {
    const res = await http.post(row.callback_url, row.payload, {
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsAppHub-Webhooks/1.0',
        'X-WAHub-Event': row.event,
        'X-WAHub-Delivery': String(row.id),
        'X-WAHub-Signature': sign(row.callback_secret || '', row.payload),
      },
      // Send the stored string as-is so the signature matches byte for byte.
      transformRequest: [(d) => d],
    });
    if (res.status >= 200 && res.status < 300) {
      await callbackDeliveryModel.markDelivered(row.id, res.status);
      log('callback.delivered', { deliveryId: row.id, code: res.status });
      return 'delivered';
    }
    return fail(`HTTP ${res.status}`, res.status);
  } catch (err) {
    return fail(err.code === 'ECONNABORTED' ? 'Timed out after 10s' : err.message || 'Network error');
  }
}

/** One dispatcher pass. */
async function tick(batch = 20) {
  const rows = await callbackDeliveryModel.claimDue(batch);
  const results = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await deliver(row));
  }
  return results;
}

let timer = null;
let busy = false;
let lastTickError = null; // log a repeating error once, not every 5s

/** Start the dispatcher loop (called from server.js). */
async function startDispatcher(intervalMs = 5000) {
  if (timer) return;
  try {
    await callbackDeliveryModel.resetSending();
  } catch (err) {
    log('callback.reset_error', { error: err.message });
  }
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
      lastTickError = null;
    } catch (err) {
      if (err.message !== lastTickError) {
        log('callback.tick_error', {
          error: err.message,
          hint: err.code === 'ER_NO_SUCH_TABLE' ? 'Run "npm run migrate".' : undefined,
        });
      }
      lastTickError = err.message;
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
}

function stopDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  enqueue, onStatusChange, deliver, tick, sign, verify,
  startDispatcher, stopDispatcher, BACKOFF_MS, MAX_ATTEMPTS,
};
