'use strict';

/**
 * Callback delivery outbox — one row per event POSTed to a project's
 * callback URL. The dispatcher claims due rows and retries with backoff.
 */

const pool = require('../db/pool');

async function enqueue({ apiClientId, event, payload }, db = pool) {
  const [r] = await db.execute(
    `INSERT INTO callback_deliveries (api_client_id, event, payload, next_attempt_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP())`,
    [apiClientId, event, payload]
  );
  return r.insertId;
}

/**
 * Claim up to `limit` due rows (pending + next_attempt_at <= now) by flipping
 * them to `sending`. Returns rows joined with the client's current URL/secret.
 */
async function claimDue(limit, db = pool) {
  const [due] = await db.query(
    `SELECT id FROM callback_deliveries
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
      ORDER BY id ASC LIMIT ?`,
    [limit]
  );
  const claimed = [];
  for (const { id } of due) {
    // eslint-disable-next-line no-await-in-loop
    const [u] = await db.execute(
      "UPDATE callback_deliveries SET status = 'sending' WHERE id = ? AND status = 'pending'",
      [id]
    );
    if (u.affectedRows === 1) claimed.push(id);
  }
  if (!claimed.length) return [];
  const [rows] = await db.query(
    `SELECT d.id, d.api_client_id, d.event, d.payload, d.attempts,
            c.callback_url, c.callback_secret, c.is_active
       FROM callback_deliveries d
       JOIN api_clients c ON c.id = d.api_client_id
      WHERE d.id IN (?)`,
    [claimed]
  );
  return rows;
}

async function markDelivered(id, code, db = pool) {
  await db.execute(
    `UPDATE callback_deliveries
        SET status = 'delivered', attempts = attempts + 1, response_code = ?,
            last_error = NULL, delivered_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [code, id]
  );
}

/** Failed attempt: retry later, or give up when nextAttemptAt is null. */
async function markAttemptFailed(id, { code = null, error, nextAttemptAt }, db = pool) {
  await db.execute(
    `UPDATE callback_deliveries
        SET status = ?, attempts = attempts + 1, response_code = ?, last_error = ?,
            next_attempt_at = ?
      WHERE id = ?`,
    [nextAttemptAt ? 'pending' : 'failed', code, String(error || '').slice(0, 500), nextAttemptAt, id]
  );
}

/** Crash recovery: anything stuck in `sending` goes back to the queue. */
async function resetSending(db = pool) {
  const [r] = await db.execute(
    "UPDATE callback_deliveries SET status = 'pending' WHERE status = 'sending'"
  );
  return r.affectedRows;
}

/** Manually redeliver a failed row. */
async function retry(id, apiClientId, db = pool) {
  const [r] = await db.execute(
    `UPDATE callback_deliveries
        SET status = 'pending', next_attempt_at = UTC_TIMESTAMP()
      WHERE id = ? AND api_client_id = ? AND status = 'failed'`,
    [id, apiClientId]
  );
  return r.affectedRows > 0;
}

async function listByClient(apiClientId, { limit = 25 } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT id, event, status, attempts, response_code, last_error,
            next_attempt_at, delivered_at, created_at
       FROM callback_deliveries
      WHERE api_client_id = ?
      ORDER BY id DESC LIMIT ?`,
    [apiClientId, limit]
  );
  return rows;
}

module.exports = { enqueue, claimDue, markDelivered, markAttemptFailed, resetSending, retry, listByClient };
