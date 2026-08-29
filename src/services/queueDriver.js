'use strict';

/**
 * Queue driver selector (design §6 "Optional Redis path", NFR-6).
 *
 * Returns the queue adapter matching `QUEUE_DRIVER`, so callers (the bulk
 * controller, the retry-failed handler) depend on ONE stable contract and never
 * branch on the driver themselves:
 *
 *   - `db`     (default) → `services/queueService` — DB-backed enqueue drained
 *                          by the node-cron worker. No Redis required.
 *   - `bullmq`           → `services/queueDriverBullmq` — persists the same rows
 *                          then pushes items onto a BullMQ/Redis queue. Opt-in;
 *                          lazy-loads bullmq only when selected.
 *
 * Both adapters expose the SAME `enqueueJob(jobData, rows)` signature and return
 * shape (design §6), which is what makes the driver swappable without touching
 * callers. The bullmq adapter additionally exposes `enqueueRetry(jobId)` used by
 * retry-failed to wake its out-of-process worker; `getDriver()` surfaces it when
 * present so the controller can call it only on the bullmq path.
 */

const defaultConfig = require('../config');
const dbQueueService = require('./queueService');

/**
 * Resolve the active queue driver.
 *
 * @param {object} [cfg] config (defaults to the app config)
 * @returns {{ name: string, enqueueJob: Function, enqueueRetry?: Function }}
 */
function getDriver(cfg = defaultConfig) {
  const driver = (cfg.queue && cfg.queue.driver) || 'db';

  if (driver === 'bullmq') {
    // Lazy-require so the bullmq adapter (and thus bullmq itself) is only pulled
    // in when actually selected — the default db path never loads it (NFR-6).
    // eslint-disable-next-line global-require
    const bullmq = require('./queueDriverBullmq');
    return {
      name: 'bullmq',
      enqueueJob: bullmq.enqueueJob,
      enqueueRetry: bullmq.enqueueRetry,
    };
  }

  // Default DB-backed driver.
  return {
    name: 'db',
    enqueueJob: dbQueueService.enqueueJob,
    // No enqueueRetry: the cron worker polls pending rows, so re-marking failed
    // rows to pending (retryFailed) is sufficient — nothing to wake up.
  };
}

module.exports = { getDriver };
