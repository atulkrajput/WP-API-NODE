'use strict';

/**
 * WebhookEvent model — data access for `webhook_events` (design §3, §5.5).
 *
 * Every inbound Meta callback is recorded here as a raw audit row. The
 * `event_hash` column is UNIQUE and is used for idempotency/dedupe: the hash is
 * derived from `wamid + status + timestamp` so a duplicate callback (Meta may
 * retry) produces the same hash and is rejected by the unique index instead of
 * being processed twice (Requirement 7.5, NFR-3).
 */

const crypto = require('crypto');

const pool = require('../db/pool');

// MySQL duplicate-key error code (thrown when the unique event_hash collides).
const ER_DUP_ENTRY = 'ER_DUP_ENTRY';

/**
 * Build the dedupe hash for a single status event.
 *
 * @param {{ wamid?: string|null, status?: string|null, timestamp?: string|null }} parts
 * @returns {string} sha256 hex digest
 */
function buildEventHash(parts) {
  const wamid = parts.wamid == null ? '' : String(parts.wamid);
  const status = parts.status == null ? '' : String(parts.status);
  const timestamp = parts.timestamp == null ? '' : String(parts.timestamp);
  return crypto
    .createHash('sha256')
    .update(`${wamid}|${status}|${timestamp}`)
    .digest('hex');
}

/**
 * Insert a webhook event row, deduping on `event_hash`.
 *
 * Attempts the INSERT; if the unique `event_hash` already exists the callback
 * has been seen before and we report it as a duplicate (no new row, no error
 * bubbled up) so the handler can skip processing while still returning 200.
 *
 * @param {{
 *   eventHash: string,
 *   wamid?: string|null,
 *   payload: object,
 *   processed?: boolean,
 * }} data
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<{ inserted: boolean, id: number|null, duplicate: boolean }>}
 */
async function insert(data, db = pool) {
  const {
    eventHash,
    wamid = null,
    payload,
    processed = false,
  } = data;

  const payloadJson =
    typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    const [result] = await db.execute(
      `INSERT INTO webhook_events (event_hash, wamid, payload, processed)
       VALUES (?, ?, ?, ?)`,
      [eventHash, wamid, payloadJson, processed ? 1 : 0]
    );
    return { inserted: true, id: result.insertId, duplicate: false };
  } catch (err) {
    if (err && err.code === ER_DUP_ENTRY) {
      // Already recorded — idempotent no-op.
      return { inserted: false, id: null, duplicate: true };
    }
    throw err;
  }
}

/**
 * Mark a previously-inserted event as processed.
 *
 * @param {number} id
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<void>}
 */
async function markProcessed(id, db = pool) {
  if (id === undefined || id === null) return;
  await db.execute(`UPDATE webhook_events SET processed = 1 WHERE id = ?`, [id]);
}

module.exports = { insert, markProcessed, buildEventHash };
