'use strict';

/**
 * Background worker (design §6, Requirement 6 (3-9), NFR-1/2/7).
 *
 * Drains the DB-backed queue (`bulk_job_items`) with no Redis dependency. The
 * worker is designed so a single `tick()` is fully unit-testable: all external
 * collaborators (WhatsAppService, models, the config, the delay function, the
 * clock and the logger) are injectable via a `deps` object, defaulting to the
 * real implementations.
 *
 * A tick:
 *   1. Guards against overlapping runs with an in-process `isRunning` lock
 *      (Req 6.4 — never a synchronous loop; NFR-2 — no overlap).
 *   2. Atomically claims up to `WORKER_BATCH` due `pending` items
 *      (design §6 step 2).
 *   3. Processes each claimed item sequentially, waiting `SEND_DELAY_MS`
 *      BETWEEN sends (NFR-1 rate limit), sending via WhatsAppService, then:
 *        - success            → item `sent` + `wamid`, insert a `messages` row
 *                               (`accepted`), bump `sent_count` (Req 6.5, 6.8).
 *        - transient failure  → requeue with `attempts++` and exponential
 *          & attempts left      backoff `next_attempt_at` (Req 6.7, NFR-1).
 *        - permanent / exhausted → item `failed` + error, bump `failed_count`,
 *                               and continue with the rest (Req 6.6).
 *   4. Detects job completion: a job with no `pending`/`processing` items left
 *      is set `completed` (design §6 step 4, Req 6.8).
 *
 * Item-level failures are isolated: a thrown error while handling one item is
 * caught, logged and turned into a failed item, so it never crashes the tick
 * or the process (NFR-2).
 *
 * The startup reconciler (`reconcile`) resets stuck `processing` items back to
 * `pending` on boot, guarded by `wamid IS NULL` to avoid double-sending items
 * that were actually accepted (design §6 crash safety, Req 6.9).
 */

const cron = require('node-cron');

const defaultConfig = require('../config');
const defaultWhatsappService = require('../services/whatsappService');
const defaultBulkJobModel = require('../models/bulkJob');
const defaultBulkJobItemModel = require('../models/bulkJobItem');
const defaultMessageModel = require('../models/message');

/** Current UTC time as a MySQL DATETIME string ("YYYY-MM-DD HH:MM:SS"). */
function utcNow(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 19).replace('T', ' ');
}

/** A UTC DATETIME `ms` milliseconds from `now`. */
function utcPlus(ms, now = Date.now()) {
  return utcNow(now + ms);
}

/** Default async delay (real timers). Injectable so tests can fake it. */
function realDelay(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Structured logger (NFR-7). Defaults to console with a stable event shape.
 * Never logs secrets — only ids, statuses, counts and error reasons.
 */
const defaultLogger = {
  info: (event, data) =>
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'info', event, ...data })),
  warn: (event, data) =>
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ level: 'warn', event, ...data })),
  error: (event, data) =>
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', event, ...data })),
};

/**
 * Classify a normalized WhatsAppService failure as transient or permanent
 * (Req 6.7, NFR-1).
 *
 * Transient (retryable with backoff):
 *   - HTTP 429 / Meta rate-limit codes (numeric 4 in the 130xxx throttling
 *     family or the literal 429),
 *   - HTTP 5xx (server errors),
 *   - network-level failures surfaced by WhatsAppService as string codes:
 *     ETIMEDOUT, ECONNABORTED, ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN.
 *
 * Everything else (bad template, invalid number, policy rejection, etc.) is
 * permanent and must not be retried.
 *
 * @param {{ code?: string|number|null, title?: string, detail?: string }} result
 * @returns {boolean} true when the failure should be retried
 */
function isTransient(result) {
  if (!result) return false;

  const raw = result.code;
  const codeStr = raw == null ? '' : String(raw).toUpperCase();

  // Network / timeout codes surfaced as strings.
  const NETWORK_CODES = [
    'ETIMEDOUT',
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
  ];
  if (NETWORK_CODES.includes(codeStr)) return true;

  // Numeric HTTP-ish codes.
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric === 429) return true; // explicit rate limit
    if (numeric >= 500 && numeric <= 599) return true; // server errors
    // Meta rate-limit / throttling error codes (design §5.3, NFR-1).
    // 130429 (rate limit hit), 131048 (spam rate limit), 131056 (pair rate
    // limit), 133016 (too many messages) — treat the known throttling codes as
    // transient.
    const META_TRANSIENT = new Set([130429, 131048, 131056, 133016, 80007]);
    if (META_TRANSIENT.has(numeric)) return true;
  }

  // Textual hints (defensive) — a rate-limit worded error.
  const text = `${result.title || ''} ${result.detail || ''}`.toLowerCase();
  if (text.includes('rate limit') || text.includes('too many requests')) {
    return true;
  }

  return false;
}

/**
 * Compute an exponential backoff delay in ms (NFR-1).
 *
 *   delay = min(base * 2^(attempts-1), cap)
 *
 * `attempts` is the post-increment attempt count (1 after the first failure).
 *
 * @param {number} attempts current attempts count (>= 1)
 * @param {number} baseMs base delay (the configured inter-send delay)
 * @param {number} [capMs] maximum backoff
 * @returns {number} delay in ms
 */
function backoffMs(attempts, baseMs, capMs = 5 * 60 * 1000) {
  const a = Math.max(1, attempts);
  const raw = baseMs * Math.pow(2, a - 1);
  return Math.min(raw, capMs);
}

/**
 * Build Cloud API template `components` from an item's resolved `variables`
 * (design §5.1, mirrors the message controller's buildComponents). `variables`
 * is stored as a position→value map (e.g. { "1": "Alice", "2": "NYC" }) or as
 * an ordered array. Empty values are dropped; an empty result yields no
 * components (WhatsAppService then omits the field).
 *
 * @param {object|Array|null} variables resolved per-row variables
 * @returns {Array<object>} components array
 */
function buildComponents(variables) {
  let ordered = [];

  if (Array.isArray(variables)) {
    ordered = variables;
  } else if (variables && typeof variables === 'object') {
    // Sort by numeric position key so {{1}}, {{2}} ... are ordered correctly.
    ordered = Object.keys(variables)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => variables[k]);
  }

  const values = ordered
    .map((v) => (v === undefined || v === null ? '' : String(v)))
    .filter((v) => v.trim() !== '');

  if (values.length === 0) return [];

  return [
    {
      type: 'body',
      parameters: values.map((text) => ({ type: 'text', text })),
    },
  ];
}

/**
 * Parse an item's `variables` column which may arrive as a JSON string (from
 * MySQL JSON columns via some drivers) or an already-parsed object/array.
 *
 * @param {any} variables
 * @returns {object|Array|null}
 */
function parseVariables(variables) {
  if (variables == null) return null;
  if (typeof variables === 'string') {
    try {
      return JSON.parse(variables);
    } catch (_e) {
      return null;
    }
  }
  return variables;
}

/**
 * Create a worker bound to a set of dependencies. All collaborators are
 * injectable so `tick`/`reconcile` are unit-testable without a live DB, real
 * timers, or the network.
 *
 * @param {object} [deps]
 * @param {object} [deps.config] config object (uses `worker` + `queue`)
 * @param {object} [deps.whatsappService] { sendTemplate, sendText }
 * @param {object} [deps.bulkJob] BulkJob model
 * @param {object} [deps.bulkJobItem] BulkJobItem model
 * @param {object} [deps.message] Message model
 * @param {(ms:number)=>Promise<void>} [deps.delay] async delay
 * @param {()=>number} [deps.now] clock (ms epoch)
 * @param {object} [deps.logger] structured logger
 * @returns {{ tick: Function, reconcile: Function, isRunning: Function,
 *   handleItem: Function }}
 */
function createWorker(deps = {}) {
  const config = deps.config || defaultConfig;
  const whatsappService = deps.whatsappService || defaultWhatsappService;
  const bulkJob = deps.bulkJob || defaultBulkJobModel;
  const bulkJobItem = deps.bulkJobItem || defaultBulkJobItemModel;
  const message = deps.message || defaultMessageModel;
  const delay = deps.delay || realDelay;
  const now = deps.now || Date.now;
  const logger = deps.logger || defaultLogger;

  const workerCfg = config.worker || {};
  const sendDelayMs = Number.isFinite(workerCfg.sendDelayMs)
    ? workerCfg.sendDelayMs
    : 1000;
  const batch = Number.isFinite(workerCfg.batch) ? workerCfg.batch : 5;
  const maxAttempts = Number.isFinite(workerCfg.maxAttempts)
    ? workerCfg.maxAttempts
    : 3;

  // In-process lock preventing overlapping ticks (design §6 step 1, NFR-2).
  let running = false;
  // Track job ids touched during a tick so we can check completion once.
  // (Local to each tick; declared per-tick below.)

  /**
   * Handle a single claimed item end-to-end (send + persist outcome). Isolated
   * so any thrown error is contained to this item (NFR-2). Returns the outcome
   * kind for the caller's counters/logging.
   *
   * @param {object} item claimed bulk_job_item row
   * @param {object} job the owning job row (for template name/language)
   * @returns {Promise<'sent'|'requeued'|'failed'>}
   */
  async function handleItem(item, job) {
    try {
      const msgType = job.msg_type || 'template';
      const to = item.to_e164;

      let result;
      if (msgType === 'text') {
        // Free-text bulk (rare) — body carried in variables[1] / raw preview.
        const vars = parseVariables(item.variables);
        const body =
          (Array.isArray(vars) ? vars[0] : vars && vars['1']) || item.raw_input;
        result = await whatsappService.sendText(to, String(body || ''));
      } else {
        const components = buildComponents(parseVariables(item.variables));
        result = await whatsappService.sendTemplate(
          to,
          job.template_name,
          job.language,
          components
        );
      }

      if (result && result.ok) {
        // Success (Req 6.5): store wamid on the item + a messages row.
        const ts = utcNow(now());
        await bulkJobItem.markSent(item.id, result.wamid || null);

        // Insert the outbound messages row (accepted, linked back to the item).
        await message.insert({
          wamid: result.wamid || null,
          toE164: to,
          msgType,
          templateName: msgType === 'template' ? job.template_name : null,
          language: msgType === 'template' ? job.language : null,
          bodyPreview:
            msgType === 'template'
              ? `template:${job.template_name || ''}`.slice(0, 500)
              : String(item.raw_input || '').slice(0, 500),
          status: 'accepted',
          bulkJobItemId: item.id,
          acceptedAt: ts,
        });

        // Bump the job's sent_count (Req 6.8).
        await bulkJob.updateCounters(job.id, {
          sentCount: (Number(job.sent_count) || 0) + 1,
        });
        job.sent_count = (Number(job.sent_count) || 0) + 1;

        logger.info('worker.item.sent', {
          jobId: job.id,
          itemId: item.id,
          wamid: result.wamid || null,
        });
        return 'sent';
      }

      // Failure — classify transient vs permanent (Req 6.6, 6.7).
      const attempts = (Number(item.attempts) || 0) + 1;
      const reason = result
        ? `${result.code || ''} ${result.title || ''} ${result.detail || ''}`.trim()
        : 'Unknown send failure';

      if (isTransient(result) && attempts < maxAttempts) {
        // Transient + attempts remaining → backoff requeue (Req 6.7, NFR-1).
        const wait = backoffMs(attempts, sendDelayMs);
        const nextAt = utcPlus(wait, now());
        await bulkJobItem.requeue(item.id, attempts, nextAt, reason);
        logger.warn('worker.item.requeued', {
          jobId: job.id,
          itemId: item.id,
          attempts,
          nextAttemptAt: nextAt,
          transient: true,
          code: result ? result.code : null,
        });
        return 'requeued';
      }

      // Permanent, or transient with attempts exhausted → failed (Req 6.6).
      await bulkJobItem.markFailed(item.id, reason);
      await bulkJob.updateCounters(job.id, {
        failedCount: (Number(job.failed_count) || 0) + 1,
      });
      job.failed_count = (Number(job.failed_count) || 0) + 1;

      logger.warn('worker.item.failed', {
        jobId: job.id,
        itemId: item.id,
        attempts,
        exhausted: isTransient(result),
        code: result ? result.code : null,
      });
      return 'failed';
    } catch (err) {
      // Item-level isolation (NFR-2): never let one item crash the tick.
      logger.error('worker.item.error', {
        jobId: job && job.id,
        itemId: item && item.id,
        error: err && err.message ? err.message : String(err),
      });
      try {
        await bulkJobItem.markFailed(
          item.id,
          err && err.message ? err.message : 'Worker error'
        );
        await bulkJob.updateCounters(job.id, {
          failedCount: (Number(job.failed_count) || 0) + 1,
        });
        job.failed_count = (Number(job.failed_count) || 0) + 1;
      } catch (inner) {
        logger.error('worker.item.error.persist', {
          itemId: item && item.id,
          error: inner && inner.message ? inner.message : String(inner),
        });
      }
      return 'failed';
    }
  }

  /**
   * Run one worker tick (design §6). Guarded by the in-process lock; safe to
   * call repeatedly. Returns a small summary useful for tests and logging.
   *
   * @returns {Promise<{ claimed:number, sent:number, requeued:number,
   *   failed:number, skipped:boolean }>}
   */
  async function tick() {
    if (running) {
      // Overlap guard (NFR-2) — a previous tick is still in flight.
      logger.info('worker.tick.skipped', { reason: 'already_running' });
      return { claimed: 0, sent: 0, requeued: 0, failed: 0, skipped: true };
    }
    running = true;

    const summary = { claimed: 0, sent: 0, requeued: 0, failed: 0, skipped: false };
    const jobCache = new Map(); // jobId → job row (fetched once per tick)
    const touchedJobs = new Set();

    try {
      const items = await bulkJobItem.claimPending(batch);
      summary.claimed = items.length;

      if (items.length === 0) {
        return summary;
      }

      logger.info('worker.tick.claimed', { count: items.length });

      let first = true;
      for (const item of items) {
        // Rate limit (NFR-1): wait SEND_DELAY_MS BETWEEN sends, not before the
        // first one, so a batch of N takes ~ (N-1) * delay.
        if (!first) {
          await delay(sendDelayMs);
        }
        first = false;

        // Load (and cache) the owning job once per tick.
        let job = jobCache.get(item.job_id);
        if (!job) {
          job = await bulkJob.getById(item.job_id);
          if (!job) {
            // Orphaned item (job deleted) — fail it and move on (NFR-2).
            await bulkJobItem.markFailed(item.id, 'Owning job not found');
            summary.failed += 1;
            continue;
          }
          jobCache.set(item.job_id, job);
        }
        touchedJobs.add(item.job_id);

        const outcome = await handleItem(item, job);
        if (outcome === 'sent') summary.sent += 1;
        else if (outcome === 'requeued') summary.requeued += 1;
        else summary.failed += 1;
      }

      // Job completion detection (design §6 step 4, Req 6.8): any touched job
      // with no outstanding pending/processing items is completed.
      for (const jobId of touchedJobs) {
        const outstanding = await bulkJobItem.countOutstanding(jobId);
        if (outstanding === 0) {
          await bulkJob.updateStatus(jobId, 'completed');
          logger.info('worker.job.completed', { jobId });
        }
      }

      logger.info('worker.tick.done', {
        claimed: summary.claimed,
        sent: summary.sent,
        requeued: summary.requeued,
        failed: summary.failed,
      });
      return summary;
    } catch (err) {
      // A tick-level failure must not crash the process (NFR-2).
      logger.error('worker.tick.error', {
        error: err && err.message ? err.message : String(err),
      });
      return summary;
    } finally {
      running = false;
    }
  }

  /**
   * Startup reconciler (design §6 crash safety, Req 6.9). Resets stuck
   * `processing` items (older than `stuckMs`, default 2 * tick interval) back to
   * `pending`, guarded by `wamid IS NULL` so accepted items are never re-sent.
   *
   * @param {{ stuckMs?: number }} [opts]
   * @returns {Promise<{ reset:number }>}
   */
  async function reconcile(opts = {}) {
    const intervalSec = Number.isFinite((config.worker || {}).intervalSec)
      ? config.worker.intervalSec
      : 5;
    // Default threshold: two tick intervals (ms), min 10s.
    const stuckMs = Number.isFinite(opts.stuckMs)
      ? opts.stuckMs
      : Math.max(intervalSec * 2 * 1000, 10 * 1000);

    const threshold = utcPlus(-stuckMs, now());
    try {
      const reset = await bulkJobItem.resetStuckProcessing(threshold);
      logger.info('worker.reconcile', { reset, threshold });
      return { reset };
    } catch (err) {
      logger.error('worker.reconcile.error', {
        error: err && err.message ? err.message : String(err),
      });
      return { reset: 0 };
    }
  }

  return {
    tick,
    reconcile,
    handleItem,
    isRunning: () => running,
  };
}

// A lazily-created shared worker for the running app.
let sharedWorker = null;
function getWorker() {
  if (!sharedWorker) sharedWorker = createWorker();
  return sharedWorker;
}

// The scheduled cron task handle (so it can be stopped on shutdown).
let scheduledTask = null;

/**
 * Start the background worker under node-cron (design §6). Only meaningful for
 * the DB queue driver; when `QUEUE_DRIVER=bullmq` this is a no-op so the BullMQ
 * path (Task 15) can own scheduling. Runs the startup reconciler once, then
 * schedules a tick every `WORKER_INTERVAL_SEC` seconds.
 *
 * Guarded so importing modules (e.g. tests) never auto-start the cron loop —
 * `server.js` calls this explicitly on boot.
 *
 * @param {object} [opts]
 * @param {object} [opts.config] override config (tests)
 * @returns {Promise<{ started: boolean, task: object|null }>}
 */
async function startWorker(opts = {}) {
  const cfg = opts.config || defaultConfig;

  if ((cfg.queue || {}).driver === 'bullmq') {
    defaultLogger.info('worker.start.skipped', { reason: 'bullmq_driver' });
    return { started: false, task: null };
  }

  const worker = getWorker();

  // Crash-safe resume (Req 6.9): reconcile stuck items before scheduling ticks.
  await worker.reconcile();

  const intervalSec = Number.isFinite((cfg.worker || {}).intervalSec)
    ? cfg.worker.intervalSec
    : 5;
  // node-cron expression: every N seconds.
  const expr = `*/${Math.max(1, intervalSec)} * * * * *`;

  scheduledTask = cron.schedule(expr, () => {
    // Fire-and-forget; tick() has its own overlap guard + error isolation.
    worker.tick().catch((err) => {
      defaultLogger.error('worker.tick.unhandled', {
        error: err && err.message ? err.message : String(err),
      });
    });
  });

  defaultLogger.info('worker.started', { intervalSec });
  return { started: true, task: scheduledTask };
}

/** Stop the scheduled worker (used on graceful shutdown). */
function stopWorker() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = {
  createWorker,
  startWorker,
  stopWorker,
  getWorker,
  // Exported for testing / reuse.
  isTransient,
  backoffMs,
  buildComponents,
  parseVariables,
  utcNow,
  utcPlus,
};
