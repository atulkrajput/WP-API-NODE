'use strict';

/**
 * Message model — data access for the `messages` table (design §3).
 *
 * Every outbound message (single send or bulk item) gets a row here. Task 6
 * uses `insert` to persist single-send outcomes (accepted with a `wamid`, or
 * failed with a Meta error), and `getById` to power the status polling endpoint
 * (`GET /messages/:id/status`). Later tasks reuse this model for bulk items and
 * the webhook status handler advances the stored status.
 */

const pool = require('../db/pool');

/**
 * Insert a message row.
 *
 * Columns per design §3 (`messages` table):
 *   wamid, to_e164, direction, msg_type, template_name, language,
 *   body_preview, status, error_code, error_title, error_detail,
 *   bulk_job_item_id, accepted_at, sent_at, delivered_at, read_at, failed_at
 *
 * @param {{
 *   wamid?: string|null,
 *   toE164: string,
 *   direction?: 'outbound',
 *   msgType: 'template'|'text',
 *   templateName?: string|null,
 *   language?: string|null,
 *   bodyPreview?: string|null,
 *   status?: 'accepted'|'sent'|'delivered'|'read'|'failed',
 *   errorCode?: string|null,
 *   errorTitle?: string|null,
 *   errorDetail?: string|null,
 *   bulkJobItemId?: number|null,
 *   acceptedAt?: string|null,
 *   sentAt?: string|null,
 *   deliveredAt?: string|null,
 *   readAt?: string|null,
 *   failedAt?: string|null,
 * }} data
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} inserted row id
 */
async function insert(data, db = pool) {
  const {
    wamid = null,
    toE164,
    direction = 'outbound',
    msgType,
    templateName = null,
    language = null,
    bodyPreview = null,
    status = 'accepted',
    errorCode = null,
    errorTitle = null,
    errorDetail = null,
    bulkJobItemId = null,
    acceptedAt = null,
    sentAt = null,
    deliveredAt = null,
    readAt = null,
    failedAt = null,
  } = data;

  const [result] = await db.execute(
    `INSERT INTO messages
       (wamid, to_e164, direction, msg_type, template_name, language,
        body_preview, status, error_code, error_title, error_detail,
        bulk_job_item_id, accepted_at, sent_at, delivered_at, read_at, failed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      wamid,
      toE164,
      direction,
      msgType,
      templateName,
      language,
      bodyPreview,
      status,
      errorCode,
      errorTitle,
      errorDetail,
      bulkJobItemId,
      acceptedAt,
      sentAt,
      deliveredAt,
      readAt,
      failedAt,
    ]
  );

  return result.insertId;
}

/**
 * Fetch a single message by id (used by the status polling endpoint).
 *
 * @param {number|string} id
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<object|null>} the message row, or null when not found
 */
async function getById(id, db = pool) {
  if (id === undefined || id === null || id === '') return null;

  const [rows] = await db.execute(
    `SELECT id, wamid, to_e164, direction, msg_type, template_name, language,
            body_preview, status, error_code, error_title, error_detail,
            bulk_job_item_id, accepted_at, sent_at, delivered_at, read_at,
            failed_at, created_at
       FROM messages
      WHERE id = ?
      LIMIT 1`,
    [id]
  );

  return rows.length ? rows[0] : null;
}

/**
 * Fetch a single message by its Meta message id (`wamid`).
 *
 * Used by the webhook status handler to match an inbound status callback to the
 * outbound message it refers to (design §5.5). `wamid` is UNIQUE, so at most one
 * row is returned.
 *
 * @param {string} wamid
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<object|null>} the message row, or null when not found
 */
async function findByWamid(wamid, db = pool) {
  if (wamid === undefined || wamid === null || wamid === '') return null;

  const [rows] = await db.execute(
    `SELECT id, wamid, to_e164, direction, msg_type, template_name, language,
            body_preview, status, error_code, error_title, error_detail,
            bulk_job_item_id, accepted_at, sent_at, delivered_at, read_at,
            failed_at, created_at
       FROM messages
      WHERE wamid = ?
      LIMIT 1`,
    [wamid]
  );

  return rows.length ? rows[0] : null;
}

// Monotonic rank of the successful delivery statuses (design §3
// "Status monotonicity"): accepted(0) < sent(1) < delivered(2) < read(3).
const STATUS_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };

// Maps an incoming status to the timestamp column it should populate.
const STATUS_TIMESTAMP_COLUMN = {
  accepted: 'accepted_at',
  sent: 'sent_at',
  delivered: 'delivered_at',
  read: 'read_at',
  failed: 'failed_at',
};

/**
 * Advance a message's status monotonically (design §3, NFR-3).
 *
 * Rules:
 * - Ranked statuses only advance forward: a status is applied only when its
 *   rank is strictly higher than the current status's rank. A late `delivered`
 *   therefore never overwrites `read`.
 * - `failed` is applied only when the message is not already `read` (a `read`
 *   message is a confirmed success and is not regressed to failed by a late
 *   error callback). When applied, the error code/title/detail are stored.
 * - Whatever status is applied, its matching timestamp column is set.
 *
 * The UPDATE is guarded in SQL by the current status so concurrent/duplicate
 * callbacks cannot regress the row even if they interleave.
 *
 * @param {string} wamid
 * @param {'sent'|'delivered'|'read'|'failed'} status incoming status
 * @param {{ timestamp?: string|null, errorCode?: string|null,
 *   errorTitle?: string|null, errorDetail?: string|null }} [opts]
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<{ matched: boolean, updated: boolean, from: string|null,
 *   to: string|null }>} outcome describing whether a row matched and whether it
 *   was actually advanced
 */
async function advanceStatus(wamid, status, opts = {}, db = pool) {
  const current = await findByWamid(wamid, db);
  if (!current) {
    return { matched: false, updated: false, from: null, to: null };
  }

  const from = current.status;
  const ts = opts.timestamp || null;
  const tsColumn = STATUS_TIMESTAMP_COLUMN[status];

  if (status === 'failed') {
    // Do not regress a confirmed `read` to `failed`.
    if (from === 'read') {
      return { matched: true, updated: false, from, to: from };
    }
    // Guard on current status so a duplicate/late callback is a no-op.
    const [result] = await db.execute(
      `UPDATE messages
          SET status = 'failed',
              error_code = ?,
              error_title = ?,
              error_detail = ?,
              failed_at = COALESCE(failed_at, ?)
        WHERE wamid = ?
          AND status <> 'read'
          AND status <> 'failed'`,
      [
        opts.errorCode || null,
        opts.errorTitle || null,
        opts.errorDetail || null,
        ts,
        wamid,
      ]
    );
    const updated = result.affectedRows > 0;
    return { matched: true, updated, from, to: updated ? 'failed' : from };
  }

  const incomingRank = STATUS_RANK[status];
  if (incomingRank === undefined) {
    // Unknown status — do not touch the row.
    return { matched: true, updated: false, from, to: from };
  }

  const currentRank = STATUS_RANK[from];
  // A message currently `failed` has no rank; per the rules above we only
  // advance ranked statuses forward, and we never regress `read`. We treat a
  // `failed` message as terminal for ranked advances too.
  if (currentRank === undefined || incomingRank <= currentRank) {
    return { matched: true, updated: false, from, to: from };
  }

  // Advance forward. Guard in SQL on the current rank via an explicit status
  // list of the statuses strictly below the incoming one so concurrent
  // duplicates cannot regress the row.
  const lowerStatuses = Object.keys(STATUS_RANK).filter(
    (s) => STATUS_RANK[s] < incomingRank
  );
  const placeholders = lowerStatuses.map(() => '?').join(', ');

  const [result] = await db.execute(
    `UPDATE messages
        SET status = ?,
            ${tsColumn} = COALESCE(${tsColumn}, ?)
      WHERE wamid = ?
        AND status IN (${placeholders})`,
    [status, ts, wamid, ...lowerStatuses]
  );

  const updated = result.affectedRows > 0;
  return { matched: true, updated, from, to: updated ? status : from };
}

/**
 * List the most recent messages, newest first (Task 13 dashboard summary).
 * Powers the dashboard's "recent messages" panel with a small, bounded slice
 * of outbound sends and their current (webhook-driven) status.
 *
 * @param {{ limit?: number }} [opts]
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<Array<object>>}
 */
async function recent(opts = {}, db = pool) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 10;

  const [rows] = await db.query(
    `SELECT id, wamid, to_e164, direction, msg_type, template_name, language,
            body_preview, status, error_code, error_title, error_detail,
            bulk_job_item_id, accepted_at, sent_at, delivered_at, read_at,
            failed_at, created_at
       FROM messages
      ORDER BY id DESC
      LIMIT ?`,
    [limit]
  );

  return rows;
}

module.exports = {
  insert,
  getById,
  findByWamid,
  advanceStatus,
  recent,
  // Exported for testing / reuse.
  STATUS_RANK,
  STATUS_TIMESTAMP_COLUMN,
};
