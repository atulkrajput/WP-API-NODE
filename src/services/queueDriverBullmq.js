'use strict';

/**
 * Optional BullMQ + Redis queue driver (design §6 "Optional Redis path", NFR-6).
 *
 * This is an OPT-IN adapter selected via `QUEUE_DRIVER=bullmq`. It honors the
 * SAME service contract as the default DB-backed path so callers never change:
 *
 *   - `enqueueJob(jobData, rows)` — identical shape/return to
 *     `services/queueService.enqueueJob`. It still persists the `bulk_jobs` +
 *     `bulk_job_items` rows (so history / progress / retry-failed all keep
 *     working exactly as with the DB driver), then instead of relying on the
 *     node-cron worker to poll, it pushes each pending item onto a BullMQ queue
 *     for a BullMQ `Worker` to process.
 *
 *   - `startWorker()` — spins up a BullMQ `Worker` whose per-job processor calls
 *     the SAME item-handling logic the DB worker uses (`worker.createWorker().handleItem`),
 *     so a message is sent, a `messages` row is written, and the job counters /
 *     completion are advanced identically. This is the analogue of the DB
 *     worker's node-cron tick.
 *
 * DEPENDENCY POLICY (NFR-6): `bullmq` and `ioredis` are NOT hard dependencies of
 * this project. They are declared under `optionalDependencies` so the default DB
 * install never fails if they can't be built, and they are `require()`d LAZILY
 * — only when this module's functions actually run (i.e. only when
 * `QUEUE_DRIVER=bullmq`). If the packages are missing (or `REDIS_URL` is not
 * set), a clear, actionable error is thrown/logged rather than a cryptic
 * MODULE_NOT_FOUND. The default `db` path never touches this file.
 *
 * To USE this path:
 *   1. `npm install bullmq ioredis`   (or ensure the optionalDependencies built)
 *   2. set `QUEUE_DRIVER=bullmq` and `REDIS_URL=redis://host:6379`
 *   3. start the app — `startWorker()` will launch the BullMQ worker.
 */

const defaultConfig = require('../config');
const bulkJobModel = require('../models/bulkJob');
const bulkJobItemModel = require('../models/bulkJobItem');
const { createWorker } = require('../worker/worker');

/** Fixed BullMQ queue name for bulk send items. */
const QUEUE_NAME = 'bulk-send-items';

/**
 * Lazily load the optional `bullmq` package with a clear error when it (or its
 * Redis peer) is not installed. Kept as a function so merely importing this
 * module never requires bullmq — only calling into the driver does (NFR-6).
 *
 * @returns {typeof import('bullmq')}
 * @throws {Error} a descriptive error when bullmq is not installed
 */
function loadBullmq() {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    return require('bullmq');
  } catch (err) {
    const e = new Error(
      "QUEUE_DRIVER=bullmq requires the optional 'bullmq' package. " +
        "Install it with `npm install bullmq ioredis` and set REDIS_URL, " +
        'or use the default QUEUE_DRIVER=db (no Redis needed). ' +
        `Original error: ${err && err.message ? err.message : err}`
    );
    e.code = 'BULLMQ_NOT_INSTALLED';
    throw e;
  }
}

/**
 * Resolve the Redis connection options BullMQ needs from `REDIS_URL`. BullMQ
 * accepts a connection object; passing the URL through `connection: { url }` (or
 * an ioredis instance) works across versions. We throw a clear error when no
 * URL is configured so the failure is actionable (NFR-6, design §7).
 *
 * @param {object} cfg config object
 * @returns {{ url: string }}
 * @throws {Error} when REDIS_URL is not set
 */
function resolveConnection(cfg) {
  const url = (cfg.queue && cfg.queue.redisUrl) || '';
  if (!url) {
    const e = new Error(
      'QUEUE_DRIVER=bullmq requires REDIS_URL to be set (e.g. ' +
        'redis://127.0.0.1:6379). See .env.example.'
    );
    e.code = 'REDIS_URL_MISSING';
    throw e;
  }
  return { url };
}

/**
 * Build (once) and return the shared BullMQ `Queue` instance. Lazy so nothing
 * connects to Redis until the bullmq driver is actually used.
 *
 * @param {object} [deps]
 * @param {object} [deps.config]
 * @param {typeof import('bullmq')} [deps.bullmq] injected bullmq (tests)
 * @returns {import('bullmq').Queue}
 */
let sharedQueue = null;
function getQueue(deps = {}) {
  const cfg = deps.config || defaultConfig;
  const bullmq = deps.bullmq || loadBullmq();
  const connection = resolveConnection(cfg);

  if (sharedQueue) return sharedQueue;
  sharedQueue = new bullmq.Queue(QUEUE_NAME, { connection });
  return sharedQueue;
}

/**
 * Enqueue a bulk send job on the BullMQ path (design §6 optional Redis path).
 *
 * Same signature + return shape as `services/queueService.enqueueJob` so the
 * bulk controller is unchanged. It persists the job + items (valid → pending,
 * invalid → skipped_invalid) via the models — keeping history, progress, and
 * retry-failed working — then pushes one BullMQ job per pending item so a
 * BullMQ Worker (see `startWorker`) processes them out-of-process.
 *
 * @param {object} jobData see queueService.enqueueJob
 * @param {Array<object>} rows see queueService.enqueueJob
 * @param {object} [deps] injectable collaborators (tests)
 * @returns {Promise<{jobId:number, status:string, total:number, pending:number, skipped:number}>}
 */
async function enqueueJob(jobData, rows, deps = {}) {
  const bulkJob = deps.bulkJob || bulkJobModel;
  const bulkJobItem = deps.bulkJobItem || bulkJobItemModel;

  const recipients = Array.isArray(rows) ? rows : [];
  const total = recipients.length;
  const skipped = recipients.filter((r) => !r.valid).length;
  const pending = total - skipped;
  const status = pending > 0 ? 'running' : 'completed';

  // Persist the job (same as the DB driver) so all read paths keep working.
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

  const items = recipients.map((r) => ({
    toE164: r.toE164 || null,
    rawInput: r.rawInput,
    variables: r.variables || null,
    status: r.valid ? 'pending' : 'skipped_invalid',
    attempts: 0,
    wamid: null,
    errorDetail: r.valid ? null : r.reason || 'Failed Tier A format validation.',
    nextAttemptAt: r.valid ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
  }));

  if (items.length > 0) {
    await bulkJobItem.insertMany(jobId, items);
  }

  // Push a BullMQ job per pending item so the BullMQ worker drains them. We
  // enqueue by job id (the worker re-claims pending items from the DB), which
  // keeps the DB the single source of truth for item state and lets
  // retry-failed simply re-mark rows pending + re-enqueue.
  if (pending > 0) {
    const queue = deps.queue || getQueue(deps);
    await queue.add('drain-job', { jobId }, { removeOnComplete: true, removeOnFail: true });
  }

  return { jobId, status, total, pending, skipped };
}

/**
 * Enqueue a re-drain of a job whose failed items were just re-queued
 * (Requirement 8.5, BullMQ path). The retry-failed controller already flips the
 * rows back to `pending` in the DB; on the BullMQ path we additionally push a
 * job so the BullMQ worker wakes up and drains them (the DB path relies on the
 * cron poller instead). Safe to call with the shared queue.
 *
 * @param {number|string} jobId
 * @param {object} [deps]
 * @returns {Promise<void>}
 */
async function enqueueRetry(jobId, deps = {}) {
  const queue = deps.queue || getQueue(deps);
  await queue.add('drain-job', { jobId }, { removeOnComplete: true, removeOnFail: true });
}

/**
 * Start the BullMQ worker (design §6 optional Redis path). This is the BullMQ
 * analogue of the DB worker's node-cron loop: for each queued "drain-job", it
 * claims that job's due pending items and runs the SAME `handleItem` logic the
 * DB worker uses, so sending, `messages` rows, counters and completion are all
 * identical. Lazy-requires bullmq and throws a clear error when it/Redis is
 * unavailable (NFR-6).
 *
 * @param {object} [deps]
 * @param {object} [deps.config]
 * @param {typeof import('bullmq')} [deps.bullmq]
 * @param {object} [deps.worker] a worker with claim/handle (defaults to createWorker())
 * @param {object} [deps.bulkJob]
 * @param {object} [deps.bulkJobItem]
 * @param {object} [deps.logger]
 * @returns {import('bullmq').Worker}
 */
function startWorker(deps = {}) {
  const cfg = deps.config || defaultConfig;
  const bullmq = deps.bullmq || loadBullmq();
  const connection = resolveConnection(cfg);
  const bulkJob = deps.bulkJob || bulkJobModel;
  const bulkJobItem = deps.bulkJobItem || bulkJobItemModel;
  const logger = deps.logger || console;

  // Reuse the DB worker's item handler so both drivers share one code path.
  const dbWorker = deps.worker || createWorker({ config: cfg });
  const batch = Number.isFinite((cfg.worker || {}).batch) ? cfg.worker.batch : 5;

  const bullWorker = new bullmq.Worker(
    QUEUE_NAME,
    async (bullJob) => {
      const jobId = bullJob.data && bullJob.data.jobId;
      if (jobId == null) return;

      const job = await bulkJob.getById(jobId);
      if (!job) return;

      // Claim + process due pending items for this job (mirrors the DB tick,
      // but scoped to the enqueued job). claimPending claims across jobs; we
      // process whatever it returns and let completion detection settle.
      const items = await bulkJobItem.claimPending(batch);
      for (const item of items) {
        // eslint-disable-next-line no-await-in-loop
        await dbWorker.handleItem(item, job);
      }

      const outstanding = await bulkJobItem.countOutstanding(jobId);
      if (outstanding === 0) {
        await bulkJob.updateStatus(jobId, 'completed');
      }
    },
    { connection }
  );

  bullWorker.on('failed', (bullJob, err) => {
    logger.error(
      JSON.stringify({
        level: 'error',
        event: 'bullmq.job.failed',
        jobId: bullJob && bullJob.data && bullJob.data.jobId,
        error: err && err.message ? err.message : String(err),
      })
    );
  });

  logger.info &&
    logger.info(JSON.stringify({ level: 'info', event: 'bullmq.worker.started' }));

  return bullWorker;
}

/** Reset the shared queue (tests). */
function _reset() {
  sharedQueue = null;
}

module.exports = {
  QUEUE_NAME,
  enqueueJob,
  enqueueRetry,
  startWorker,
  getQueue,
  loadBullmq,
  resolveConnection,
  _reset,
};
