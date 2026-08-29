'use strict';

/**
 * QueueService — DB-backed bulk job enqueue (design §6 "Enqueue").
 *
 * This is the single entry point the bulk controller (Task 10) calls to turn a
 * parsed + validated CSV into a persisted job. It:
 *   1. creates a `bulk_jobs` row,
 *   2. inserts one `bulk_job_items` row per recipient — valid rows as `pending`
 *      with `next_attempt_at = NOW()` (ready for the worker), invalid rows as
 *      `skipped_invalid` (recorded but never sent) (Requirement 6.1, 6.2),
 *   3. sets the job's aggregate counters (total, skipped) (Requirement 6.8),
 *   4. sets the job `status='running'` when there is at least one pending item,
 *      or `completed` when every row was skipped (nothing to send).
 *
 * The contract (`enqueueJob(jobData, rows)`) is intentionally driver-agnostic so
 * the background worker (Task 11) and an optional BullMQ path (Task 15) can
 * reuse the same shape without changing callers (design §6 "Optional Redis
 * path").
 *
 * NOTE: This service does NOT send anything. Sending is the worker's job
 * (Task 11). Enqueue only creates the job + items and marks the job runnable.
 */

const bulkJobModel = require('../models/bulkJob');
const bulkJobItemModel = require('../models/bulkJobItem');

/** Current UTC time as a MySQL DATETIME string ("YYYY-MM-DD HH:MM:SS"). */
function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Enqueue a bulk send job (design §6).
 *
 * @param {{
 *   name?: string|null,
 *   templateName: string,
 *   language: string,
 *   msgType?: 'template'|'text',
 *   variablesMap?: object|null,
 * }} jobData job-level settings
 * @param {Array<{
 *   toE164?: string|null,
 *   rawInput: string,
 *   variables?: object|Array|null,
 *   valid: boolean,
 *   reason?: string|null,
 * }>} rows one entry per CSV recipient; `valid` decides pending vs skipped
 * @param {object} [deps] injectable models (for tests)
 * @param {typeof bulkJobModel} [deps.bulkJob]
 * @param {typeof bulkJobItemModel} [deps.bulkJobItem]
 * @returns {Promise<{
 *   jobId: number,
 *   status: 'running'|'completed',
 *   total: number,
 *   pending: number,
 *   skipped: number,
 * }>}
 */
async function enqueueJob(jobData, rows, deps = {}) {
  const bulkJob = deps.bulkJob || bulkJobModel;
  const bulkJobItem = deps.bulkJobItem || bulkJobItemModel;

  const recipients = Array.isArray(rows) ? rows : [];
  const total = recipients.length;
  const skipped = recipients.filter((r) => !r.valid).length;
  const pending = total - skipped;

  // A job with at least one sendable item is immediately runnable; a job whose
  // every row was invalid has nothing to send and is completed on arrival.
  const status = pending > 0 ? 'running' : 'completed';

  // 1. Create the job row with its final total/skipped counters (Req 6.8).
  const jobId = await bulkJob.create({
    name: jobData.name || null,
    templateName: jobData.templateName,
    language: jobData.language,
    msgType: jobData.msgType || 'template',
    variablesMap: jobData.variablesMap || null,
    status,
    totalCount: total,
    sentCount: 0,
    failedCount: 0,
    skippedCount: skipped,
  });

  // 2. Build item rows. Valid → pending & ready now; invalid → skipped_invalid
  //    (recorded, never sent) (Req 6.1, 6.2).
  const now = utcNow();
  const items = recipients.map((r) => {
    if (r.valid) {
      return {
        toE164: r.toE164 || null,
        rawInput: r.rawInput,
        variables: r.variables || null,
        status: 'pending',
        attempts: 0,
        wamid: null,
        errorDetail: null,
        nextAttemptAt: now,
      };
    }
    return {
      toE164: r.toE164 || null,
      rawInput: r.rawInput,
      variables: r.variables || null,
      status: 'skipped_invalid',
      attempts: 0,
      wamid: null,
      errorDetail: r.reason || 'Failed Tier A format validation.',
      nextAttemptAt: null,
    };
  });

  if (items.length > 0) {
    await bulkJobItem.insertMany(jobId, items);
  }

  return { jobId, status, total, pending, skipped };
}

module.exports = { enqueueJob };
