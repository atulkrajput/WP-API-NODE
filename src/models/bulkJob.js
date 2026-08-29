'use strict';

/**
 * BulkJob model — data access for the `bulk_jobs` table (design §3).
 *
 * One row per CSV send job. Task 10 uses `create` to persist a job when a
 * recipient CSV is uploaded, `list` to render the job list, and `getById` for
 * the detail page. `updateStatus` / `updateCounters` let the enqueue step
 * (Task 10) and the background worker (Task 11) advance job state and keep the
 * aggregate counters (total / sent / failed / skipped) in sync (Requirement
 * 6.8).
 */

const pool = require('../db/pool');

/**
 * Insert a bulk_jobs row.
 *
 * Columns per design §3 (`bulk_jobs`):
 *   name, template_name, language, msg_type, variables_map (JSON),
 *   status, total_count, sent_count, failed_count, skipped_count
 *
 * @param {{
 *   name?: string|null,
 *   templateName: string,
 *   language: string,
 *   msgType?: 'template'|'text',
 *   variablesMap?: object|null,
 *   status?: 'pending'|'running'|'completed'|'failed'|'paused',
 *   totalCount?: number,
 *   sentCount?: number,
 *   failedCount?: number,
 *   skippedCount?: number,
 * }} data
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} inserted job id
 */
async function create(data, db = pool) {
  const {
    name = null,
    templateName,
    language,
    msgType = 'template',
    variablesMap = null,
    status = 'pending',
    totalCount = 0,
    sentCount = 0,
    failedCount = 0,
    skippedCount = 0,
  } = data;

  const [result] = await db.execute(
    `INSERT INTO bulk_jobs
       (name, template_name, language, msg_type, variables_map, status,
        total_count, sent_count, failed_count, skipped_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      templateName,
      language,
      msgType,
      variablesMap == null ? null : JSON.stringify(variablesMap),
      status,
      totalCount,
      sentCount,
      failedCount,
      skippedCount,
    ]
  );

  return result.insertId;
}

/**
 * Fetch a single bulk job by id.
 *
 * @param {number|string} id
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<object|null>} the job row, or null when not found
 */
async function getById(id, db = pool) {
  if (id === undefined || id === null || id === '') return null;

  const [rows] = await db.execute(
    `SELECT id, name, template_name, language, msg_type, variables_map, status,
            total_count, sent_count, failed_count, skipped_count,
            created_at, updated_at
       FROM bulk_jobs
      WHERE id = ?
      LIMIT 1`,
    [id]
  );

  return rows.length ? rows[0] : null;
}

/**
 * List bulk jobs, newest first (Requirement 8.1 job history).
 *
 * @param {{ limit?: number }} [opts]
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<Array<object>>}
 */
async function list(opts = {}, db = pool) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 100;

  const [rows] = await db.query(
    `SELECT id, name, template_name, language, msg_type, status,
            total_count, sent_count, failed_count, skipped_count,
            created_at, updated_at
       FROM bulk_jobs
      ORDER BY id DESC
      LIMIT ?`,
    [limit]
  );

  return rows;
}

/**
 * List active bulk jobs — those still in flight (status `pending` or `running`)
 * — newest first (Task 13 dashboard "active jobs" panel).
 *
 * @param {{ limit?: number }} [opts]
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<Array<object>>}
 */
async function listActive(opts = {}, db = pool) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 20;

  const [rows] = await db.query(
    `SELECT id, name, template_name, language, msg_type, status,
            total_count, sent_count, failed_count, skipped_count,
            created_at, updated_at
       FROM bulk_jobs
      WHERE status IN ('pending', 'running')
      ORDER BY id DESC
      LIMIT ?`,
    [limit]
  );

  return rows;
}

/**
 * Update a job's status.
 *
 * @param {number|string} id
 * @param {'pending'|'running'|'completed'|'failed'|'paused'} status
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<boolean>} whether a row was updated
 */
async function updateStatus(id, status, db = pool) {
  const [result] = await db.execute(
    `UPDATE bulk_jobs SET status = ? WHERE id = ?`,
    [status, id]
  );
  return result.affectedRows > 0;
}

/**
 * Set a job's aggregate counters (Requirement 6.8). Only the provided counters
 * are updated; omitted counters are left untouched.
 *
 * @param {number|string} id
 * @param {{ totalCount?: number, sentCount?: number, failedCount?: number,
 *   skippedCount?: number }} counters
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<boolean>} whether a row was updated
 */
async function updateCounters(id, counters = {}, db = pool) {
  const sets = [];
  const params = [];

  if (counters.totalCount !== undefined) {
    sets.push('total_count = ?');
    params.push(counters.totalCount);
  }
  if (counters.sentCount !== undefined) {
    sets.push('sent_count = ?');
    params.push(counters.sentCount);
  }
  if (counters.failedCount !== undefined) {
    sets.push('failed_count = ?');
    params.push(counters.failedCount);
  }
  if (counters.skippedCount !== undefined) {
    sets.push('skipped_count = ?');
    params.push(counters.skippedCount);
  }

  if (sets.length === 0) return false;

  params.push(id);
  const [result] = await db.execute(
    `UPDATE bulk_jobs SET ${sets.join(', ')} WHERE id = ?`,
    params
  );
  return result.affectedRows > 0;
}

module.exports = { create, getById, list, listActive, updateStatus, updateCounters };
