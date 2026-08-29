'use strict';

/**
 * ValidationResult model — data access for `validation_results` (design §3).
 *
 * One row per validation attempt (Tier A format or Tier B deliverability).
 * Task 4 uses `insert` to persist Tier A format checks; later tasks reuse it
 * for bulk (batch_id) and Tier B (deliverability / wamid) results.
 */

const pool = require('../db/pool');

/**
 * Insert a validation result row.
 *
 * Columns per design §3:
 *   batch_id, raw_input, e164, country, number_type, check_type,
 *   is_valid, status, reason, wamid
 *
 * @param {{
 *   batchId?: string|null,
 *   rawInput: string,
 *   e164?: string|null,
 *   country?: string|null,
 *   numberType?: string|null,
 *   checkType: 'format'|'deliverability',
 *   isValid: boolean,
 *   status: 'valid'|'invalid'|'accepted'|'failed'|'pending',
 *   reason?: string|null,
 *   wamid?: string|null,
 * }} data
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} inserted row id
 */
async function insert(data, db = pool) {
  const {
    batchId = null,
    rawInput,
    e164 = null,
    country = null,
    numberType = null,
    checkType,
    isValid,
    status,
    reason = null,
    wamid = null,
  } = data;

  const [result] = await db.execute(
    `INSERT INTO validation_results
       (batch_id, raw_input, e164, country, number_type, check_type, is_valid, status, reason, wamid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      batchId,
      rawInput,
      e164,
      country,
      numberType,
      checkType,
      isValid ? 1 : 0,
      status,
      reason,
      wamid,
    ]
  );

  return result.insertId;
}

/**
 * Bulk-insert many validation result rows in a single statement.
 *
 * Used by bulk CSV validation (Requirement 4.6) to persist every parsed row
 * under one upload `batch_id`. Falls back to a no-op for an empty list. Each
 * row accepts the same shape as {@link insert}.
 *
 * @param {Array<{
 *   batchId?: string|null,
 *   rawInput: string,
 *   e164?: string|null,
 *   country?: string|null,
 *   numberType?: string|null,
 *   checkType: 'format'|'deliverability',
 *   isValid: boolean,
 *   status: 'valid'|'invalid'|'accepted'|'failed'|'pending',
 *   reason?: string|null,
 *   wamid?: string|null,
 * }>} rows
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<number>} number of inserted rows
 */
async function insertMany(rows, db = pool) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const values = rows.map((data) => [
    data.batchId == null ? null : data.batchId,
    data.rawInput,
    data.e164 == null ? null : data.e164,
    data.country == null ? null : data.country,
    data.numberType == null ? null : data.numberType,
    data.checkType,
    data.isValid ? 1 : 0,
    data.status,
    data.reason == null ? null : data.reason,
    data.wamid == null ? null : data.wamid,
  ]);

  // `pool.query` (not execute) supports the nested-array bulk VALUES form.
  const [result] = await db.query(
    `INSERT INTO validation_results
       (batch_id, raw_input, e164, country, number_type, check_type, is_valid, status, reason, wamid)
     VALUES ?`,
    [values]
  );

  return result.affectedRows || rows.length;
}

/**
 * List the most recent validation results, newest first (Task 13 dashboard
 * summary). Powers the dashboard's "recent validations" panel with a small,
 * bounded slice of the audit trail.
 *
 * @param {{ limit?: number }} [opts]
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<Array<object>>}
 */
async function recent(opts = {}, db = pool) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 10;

  const [rows] = await db.query(
    `SELECT id, batch_id, raw_input, e164, country, number_type, check_type,
            is_valid, status, reason, wamid, created_at
       FROM validation_results
      ORDER BY id DESC
      LIMIT ?`,
    [limit]
  );

  return rows;
}

module.exports = { insert, insertMany, recent };
