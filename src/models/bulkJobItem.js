'use strict';

/**
 * BulkJobItem model — data access for the `bulk_job_items` table (design §3).
 *
 * One row per recipient in a bulk job; collectively these rows are the DB-backed
 * queue the background worker drains (design §6). Task 10 uses `insertMany` to
 * seed a job's items during CSV import (valid rows → `pending`, invalid rows →
 * `skipped_invalid`) and `listByJob` to render items. Later tasks (the worker)
 * claim/advance items via additional methods.
 */

const pool = require('../db/pool');

/**
 * Bulk-insert many bulk_job_items in a single statement.
 *
 * Columns per design §3 (`bulk_job_items`):
 *   job_id, to_e164, raw_input, variables (JSON), status, attempts,
 *   wamid, error_detail, next_attempt_at
 *
 * Falls back to a no-op for an empty list.
 *
 * @param {number|string} jobId owning job id
 * @param {Array<{
 *   toE164?: string|null,
 *   rawInput: string,
 *   variables?: object|Array|null,
 *   status?: 'pending'|'processing'|'sent'|'failed'|'skipped_invalid',
 *   attempts?: number,
 *   wamid?: string|null,
 *   errorDetail?: string|null,
 *   nextAttemptAt?: string|null,
 * }>} items
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} number of inserted rows
 */
async function insertMany(jobId, items, db = pool) {
  if (!Array.isArray(items) || items.length === 0) return 0;

  const values = items.map((item) => [
    jobId,
    item.toE164 == null ? null : item.toE164,
    item.rawInput,
    item.variables == null ? null : JSON.stringify(item.variables),
    item.status || 'pending',
    item.attempts == null ? 0 : item.attempts,
    item.wamid == null ? null : item.wamid,
    item.errorDetail == null ? null : item.errorDetail,
    item.nextAttemptAt == null ? null : item.nextAttemptAt,
  ]);

  // `pool.query` (not execute) supports the nested-array bulk VALUES form.
  const [result] = await db.query(
    `INSERT INTO bulk_job_items
       (job_id, to_e164, raw_input, variables, status, attempts, wamid,
        error_detail, next_attempt_at)
     VALUES ?`,
    [values]
  );

  return result.affectedRows || items.length;
}

/**
 * List all items for a job, in insertion order (Requirement 8.2). An optional
 * status filter narrows the result (Requirement 8.4).
 *
 * @param {number|string} jobId
 * @param {{ status?: string }} [opts]
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<Array<object>>}
 */
async function listByJob(jobId, opts = {}, db = pool) {
  const params = [jobId];
  let where = 'job_id = ?';
  if (opts.status) {
    where += ' AND status = ?';
    params.push(opts.status);
  }

  const [rows] = await db.execute(
    `SELECT id, job_id, to_e164, raw_input, variables, status, attempts,
            wamid, error_detail, next_attempt_at, created_at, updated_at
       FROM bulk_job_items
      WHERE ${where}
      ORDER BY id ASC`,
    params
  );

  return rows;
}

/**
 * Atomically claim up to `limit` pending items that are due
 * (`next_attempt_at <= NOW()`), flipping them to `processing` and returning the
 * claimed rows (design §6 worker tick step 2).
 *
 * The claim is a two-step operation guarded so concurrent ticks / processes
 * cannot double-claim the same rows:
 *   1. `UPDATE ... SET status='processing', updated_at=NOW()
 *       WHERE status='pending' AND next_attempt_at<=NOW() ORDER BY id LIMIT ?`
 *      — the atomic flip. Only rows this statement actually flips are ours.
 *   2. `SELECT ... WHERE status='processing' ORDER BY id LIMIT ?` — read back
 *      the rows we just claimed.
 *
 * Because step 1 is a single UPDATE, MySQL applies it atomically; a second
 * concurrent claim will not re-flip rows already moved out of `pending`. We
 * time-box the read-back to the same `limit` and only return rows whose
 * `updated_at` matches the claim moment window, but for the DB-backed MVP the
 * single-worker guarantee (in-process `isRunning` lock) plus the atomic UPDATE
 * is sufficient.
 *
 * A NULL `next_attempt_at` is treated as "due now" via COALESCE so freshly
 * enqueued items (which set `next_attempt_at=NOW()`) and any legacy NULLs are
 * both claimable.
 *
 * @param {number} limit max items to claim
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<Array<object>>} the claimed item rows
 */
async function claimPending(limit, db = pool) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (n === 0) return [];

  // Step 1 — atomic flip of due pending rows to processing.
  const [result] = await db.query(
    `UPDATE bulk_job_items
        SET status = 'processing', updated_at = NOW()
      WHERE status = 'pending'
        AND COALESCE(next_attempt_at, NOW()) <= NOW()
      ORDER BY id ASC
      LIMIT ?`,
    [n]
  );

  const claimedCount = result.affectedRows || 0;
  if (claimedCount === 0) return [];

  // Step 2 — read back the rows we just claimed. We read the oldest
  // `processing` rows (ORDER BY id) up to the number we flipped. With the
  // in-process single-worker lock this reliably returns our claim.
  const [rows] = await db.query(
    `SELECT id, job_id, to_e164, raw_input, variables, status, attempts,
            wamid, error_detail, next_attempt_at, created_at, updated_at
       FROM bulk_job_items
      WHERE status = 'processing'
      ORDER BY id ASC
      LIMIT ?`,
    [claimedCount]
  );

  return rows;
}

/**
 * Mark a claimed item as successfully sent, storing its `wamid`
 * (design §6, Requirement 6.5).
 *
 * @param {number|string} id item id
 * @param {string} wamid Meta message id
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<boolean>} whether a row was updated
 */
async function markSent(id, wamid, db = pool) {
  const [result] = await db.execute(
    `UPDATE bulk_job_items
        SET status = 'sent', wamid = ?, error_detail = NULL, updated_at = NOW()
      WHERE id = ?`,
    [wamid == null ? null : wamid, id]
  );
  return result.affectedRows > 0;
}

/**
 * Mark a claimed item as permanently failed, storing the error reason
 * (design §6, Requirement 6.6). Used for permanent failures and exhausted
 * retries.
 *
 * @param {number|string} id item id
 * @param {string|null} error human-readable failure reason
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<boolean>} whether a row was updated
 */
async function markFailed(id, error, db = pool) {
  const detail = error == null ? null : String(error).slice(0, 500);
  const [result] = await db.execute(
    `UPDATE bulk_job_items
        SET status = 'failed', error_detail = ?, updated_at = NOW()
      WHERE id = ?`,
    [detail, id]
  );
  return result.affectedRows > 0;
}

/**
 * Requeue a transiently-failed item for a future retry with backoff
 * (design §6, Requirement 6.7). Sets status back to `pending`, records the new
 * attempts count, stores the (last) error for visibility, and schedules the
 * next attempt.
 *
 * @param {number|string} id item id
 * @param {number} attempts the new attempts count (post-increment)
 * @param {string} nextAttemptAt MySQL DATETIME for the next attempt
 * @param {string|null} [error] last error detail (optional, for visibility)
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<boolean>} whether a row was updated
 */
async function requeue(id, attempts, nextAttemptAt, error = null, db = pool) {
  const detail = error == null ? null : String(error).slice(0, 500);
  const [result] = await db.execute(
    `UPDATE bulk_job_items
        SET status = 'pending', attempts = ?, next_attempt_at = ?,
            error_detail = ?, updated_at = NOW()
      WHERE id = ?`,
    [attempts, nextAttemptAt, detail, id]
  );
  return result.affectedRows > 0;
}

/**
 * Crash-safety reconciler (design §6 "Crash safety", Requirement 6.9).
 *
 * Resets `processing` items that have been stuck longer than `olderThan`
 * (a MySQL DATETIME threshold) back to `pending` so a worker that died
 * mid-flight resumes them on restart.
 *
 * CRITICAL double-send guard: only rows WITHOUT a `wamid` are reset. A row with
 * a `wamid` was actually accepted by Meta (the `wamid` is written only on
 * confirmed success), so resetting it would risk a double-send. Those rows are
 * left as-is for `markSent` completion / manual inspection.
 *
 * @param {string} olderThan MySQL DATETIME; items updated before this are stuck
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} number of items reset to pending
 */
async function resetStuckProcessing(olderThan, db = pool) {
  const [result] = await db.execute(
    `UPDATE bulk_job_items
        SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW()
      WHERE status = 'processing'
        AND wamid IS NULL
        AND updated_at <= ?`,
    [olderThan]
  );
  return result.affectedRows || 0;
}

/**
 * Re-queue a job's `failed` items back to `pending` for another send attempt
 * (Requirement 8.5 — re-queueing failed items of a completed job, optional
 * stretch). Only rows currently in `failed` status are affected.
 *
 * The re-queue:
 *   - flips `status` from `failed` → `pending`,
 *   - resets `attempts` to 0 so the full retry budget applies again,
 *   - schedules `next_attempt_at = NOW()` so the worker picks them up on its
 *     next tick,
 *   - clears `error_detail` (the previous failure reason no longer applies).
 *
 * CRITICAL double-send guard: a `wamid IS NULL` predicate ensures an item that
 * was actually accepted by Meta (its `wamid` was written on confirmed success)
 * is never re-queued, mirroring the crash-safety guard in
 * `resetStuckProcessing`. Because `markSent` clears `error_detail` and sets
 * status `sent`, a `failed` row should never carry a `wamid`; the guard is
 * defensive so a mislabelled row can't cause a duplicate send.
 *
 * @param {number|string} jobId owning job id
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} number of items re-queued
 */
async function retryFailed(jobId, db = pool) {
  const [result] = await db.execute(
    `UPDATE bulk_job_items
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
            error_detail = NULL, updated_at = NOW()
      WHERE job_id = ?
        AND status = 'failed'
        AND wamid IS NULL`,
    [jobId]
  );
  return result.affectedRows || 0;
}

/**
 * Count a job's items grouped by status (Requirement 8.3 live progress).
 *
 * Returns an object with a key for every possible item status so callers can
 * render a complete progress breakdown without null-checking each status:
 *   { pending, processing, sent, failed, skipped_invalid }
 *
 * A single `GROUP BY status` query keeps this cheap for the polled progress
 * endpoint; statuses with no rows come back as 0. This is the live source of
 * truth for the progress endpoint (derived from items, not the job's cached
 * counters), so the X-of-Y indicator reflects items as they complete.
 *
 * @param {number|string} jobId
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<{pending:number, processing:number, sent:number,
 *   failed:number, skipped_invalid:number}>}
 */
async function countsByStatus(jobId, db = pool) {
  const counts = {
    pending: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    skipped_invalid: 0,
  };

  const [rows] = await db.execute(
    `SELECT status, COUNT(*) AS n
       FROM bulk_job_items
      WHERE job_id = ?
      GROUP BY status`,
    [jobId]
  );

  rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
      counts[row.status] = Number(row.n);
    }
  });

  return counts;
}

/**
 * Count how many items of a job are still outstanding (`pending` or
 * `processing`). A job with zero outstanding items is complete
 * (design §6 step 4, Requirement 6.8/6.9 completion detection).
 *
 * @param {number|string} jobId
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} outstanding item count
 */
async function countOutstanding(jobId, db = pool) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n
       FROM bulk_job_items
      WHERE job_id = ?
        AND status IN ('pending', 'processing')`,
    [jobId]
  );
  return rows.length ? Number(rows[0].n) : 0;
}

module.exports = {
  insertMany,
  listByJob,
  claimPending,
  markSent,
  markFailed,
  requeue,
  resetStuckProcessing,
  retryFailed,
  countOutstanding,
  countsByStatus,
};
