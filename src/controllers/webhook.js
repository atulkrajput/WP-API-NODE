'use strict';

/**
 * Webhook controller (Requirement 7, NFR-3 — delivery status via webhook).
 *
 * Two entry points, both public (not session-auth):
 *
 * - `getVerify` (GET /webhook) — Meta's verification handshake (design §5.4).
 *   Echoes `hub.challenge` as text/plain 200 IFF `hub.verify_token` matches the
 *   configured `WEBHOOK_VERIFY_TOKEN`; otherwise 403 (Req 7.1).
 *
 * - `postCallback` (POST /webhook) — Meta status callbacks (design §5.5).
 *   1. Verify `X-Hub-Signature-256` against the RAW body using the app secret
 *      (Req 7.2). Invalid signature → 401, nothing processed.
 *   2. Parse `entry[].changes[].value.statuses[]`.
 *   3. For each status: dedupe via `webhook_events` (unique event_hash), match
 *      the message by `wamid`, advance status monotonically and store
 *      timestamps/errors (Req 7.3, 7.4, 7.5; NFR-3). Unmatched wamids are logged
 *      rather than failing the request (Req 7.6).
 *   4. Always respond 200 quickly (Req 7.5) unless the signature check fails.
 */

const crypto = require('crypto');

const config = require('../config');
const messageModel = require('../models/message');
const webhookEventModel = require('../models/webhookEvent');

/** Structured logger that never leaks secrets (NFR-4, NFR-7). */
function log(event, fields) {
  if (config.env === 'test') return;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** Convert a Meta unix-seconds timestamp string to a UTC MySQL DATETIME. */
function metaTimestampToUtc(timestamp) {
  if (timestamp === undefined || timestamp === null || timestamp === '') {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * GET /webhook — Meta verification handshake (Req 7.1, design §5.4).
 */
function getVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = config.meta.webhookVerifyToken;

  if (mode === 'subscribe' && expected && token === expected) {
    log('webhook.verify.ok', {});
    // Echo the raw challenge as text/plain.
    return res.status(200).type('text/plain').send(String(challenge == null ? '' : challenge));
  }

  log('webhook.verify.rejected', { mode: mode || null });
  return res.sendStatus(403);
}

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body
 * (Req 7.2, design §5.5). Uses a constant-time comparison.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function verifySignature(req) {
  const appSecret = config.meta.appSecret;
  if (!appSecret) return false;

  const header = req.get('x-hub-signature-256');
  if (!header || !header.startsWith('sha256=')) return false;

  const raw = req.rawBody instanceof Buffer ? req.rawBody : Buffer.from(req.rawBody || '');
  const expected =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Extract every status object from the Meta payload
 * (`entry[].changes[].value.statuses[]`, design §5.5). Tolerates missing
 * intermediate keys.
 *
 * @param {object} body
 * @returns {Array<object>}
 */
function extractStatuses(body) {
  const statuses = [];
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change && change.value;
      const list = value && Array.isArray(value.statuses) ? value.statuses : [];
      for (const status of list) {
        if (status && typeof status === 'object') statuses.push(status);
      }
    }
  }
  return statuses;
}

/** Normalize the first error entry of a status into code/title/detail. */
function extractError(statusObj) {
  const errors = Array.isArray(statusObj && statusObj.errors)
    ? statusObj.errors
    : [];
  if (errors.length === 0) return { code: null, title: null, detail: null };
  const e = errors[0] || {};
  const detail =
    (e.error_data && e.error_data.details) || e.message || e.details || null;
  return {
    code: e.code === undefined || e.code === null ? null : String(e.code),
    title: e.title || null,
    detail: detail ? String(detail).slice(0, 500) : null,
  };
}

/**
 * POST /webhook — Meta status callbacks (Req 7.2–7.6, NFR-3, design §5.5).
 */
async function postCallback(req, res, next) {
  // Req 7.2 — verify signature against the RAW body BEFORE any processing.
  if (!verifySignature(req)) {
    log('webhook.signature.invalid', {});
    return res.sendStatus(401);
  }

  // Respond 200 fast; process synchronously first (the work is small) but the
  // handler is written so processing failures never turn into non-200s except
  // the signature failure above.
  try {
    const body = req.body || {};
    const statuses = extractStatuses(body);

    for (const statusObj of statuses) {
      const wamid = statusObj.id || null;
      const status = statusObj.status || null;
      const timestamp = statusObj.timestamp || null;

      if (!status) continue;

      // Dedupe via webhook_events unique event_hash (wamid+status+timestamp).
      const eventHash = webhookEventModel.buildEventHash({
        wamid,
        status,
        timestamp,
      });

      let event;
      try {
        event = await webhookEventModel.insert({
          eventHash,
          wamid,
          payload: statusObj,
          processed: false,
        });
      } catch (err) {
        // Audit insert failed for a reason other than a duplicate — log and
        // skip this status, but do not fail the whole request.
        log('webhook.event.insert_error', { wamid, error: err.message });
        continue;
      }

      if (event.duplicate) {
        // Already handled — idempotent no-op (Req 7.5).
        log('webhook.event.duplicate', { wamid, status });
        continue;
      }

      if (!wamid) {
        log('webhook.status.no_wamid', { status });
        await webhookEventModel.markProcessed(event.id);
        continue;
      }

      const when = metaTimestampToUtc(timestamp);
      const errorInfo = status === 'failed' ? extractError(statusObj) : {};

      const outcome = await messageModel.advanceStatus(
        wamid,
        status,
        {
          timestamp: when,
          errorCode: errorInfo.code,
          errorTitle: errorInfo.title,
          errorDetail: errorInfo.detail,
        }
      );

      if (!outcome.matched) {
        // Req 7.6 — log unmatched wamids rather than failing the request.
        log('webhook.status.unmatched_wamid', { wamid, status });
      } else if (outcome.updated) {
        log('webhook.status.updated', {
          wamid,
          from: outcome.from,
          to: outcome.to,
        });
      } else {
        // Monotonic guard prevented a regression / duplicate (NFR-3).
        log('webhook.status.no_change', {
          wamid,
          current: outcome.from,
          incoming: status,
        });
      }

      await webhookEventModel.markProcessed(event.id);
    }

    return res.sendStatus(200);
  } catch (err) {
    // Unexpected processing error. Still return 200 so Meta does not retry
    // endlessly; log for observability (Req 7.5/7.6, NFR-7).
    log('webhook.callback.error', { error: err.message });
    return res.sendStatus(200);
  }
}

module.exports = {
  getVerify,
  postCallback,
  // Exported for testing.
  verifySignature,
  extractStatuses,
  extractError,
  metaTimestampToUtc,
};
