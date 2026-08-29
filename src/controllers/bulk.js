'use strict';

/**
 * Bulk controller (Requirement 6.1, 6.2 — bulk send job creation).
 *
 * Task 10 scope ONLY: create the job + items from a recipient CSV and mark the
 * job runnable. The background worker that actually sends items is Task 11.
 *
 * - `getBulkPage` renders the bulk page: a list of existing jobs plus the create
 *   form (template name, language, phone column, default country, and a variable
 *   mapping from template variable positions to CSV columns).
 * - `postCreateJob` parses the uploaded CSV, runs Tier A on every row
 *   (Requirement 6.2), resolves each row's template variables from the
 *   variable-mapping (columns → values), and hands the job + rows to
 *   QueueService.enqueueJob, which creates the `bulk_jobs` row and one
 *   `bulk_job_items` row per recipient (valid → pending, invalid →
 *   skipped_invalid) (Requirement 6.1, 6.2).
 *
 * CSRF: identical decision to bulk validation (Task 9). The body is
 * multipart/form-data, and the global CSRF middleware runs BEFORE multer parses
 * the body — so the token is sent via the `x-csrf-token` HEADER, not a form
 * field. This is documented on the route and in the view's fetch() call.
 */

const { parse: parseCsv } = require('csv-parse/sync');

const phoneService = require('../services/phoneService');
const { getDriver } = require('../services/queueDriver');
const bulkJobModel = require('../models/bulkJob');
const bulkJobItemModel = require('../models/bulkJobItem');

/** Default CSV column that holds the phone number (mirrors bulk validation). */
const DEFAULT_PHONE_COLUMN = 'phone';

/**
 * Valid `bulk_job_items.status` values (design §3). Used to validate the
 * `?status=` filter on the detail page (Requirement 8.4) so an unknown filter
 * is ignored rather than passed through to the model.
 */
const ITEM_STATUSES = new Set([
  'pending',
  'processing',
  'sent',
  'failed',
  'skipped_invalid',
]);

/** Job statuses that mean the job is finished and polling can stop. */
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed']);

/**
 * Build the live progress snapshot for a job from its per-item status counts
 * (Requirement 8.3). Derives the X-of-Y numbers from the items themselves so
 * the polled figures reflect real-time completion, not a cached job counter.
 *
 * `done` counts items that have reached a terminal item state (sent + failed +
 * skipped_invalid); `percent` is done/total rounded to an integer (0 when a job
 * has no items). `finished` is true when the job's own status is terminal, which
 * the client uses to stop polling.
 *
 * @param {object} job the bulk_jobs row (for id + status)
 * @param {{pending:number, processing:number, sent:number, failed:number,
 *   skipped_invalid:number}} counts per-status item counts
 * @returns {object} progress payload (see GET /bulk/:id/progress)
 */
function buildProgress(job, counts) {
  const sent = counts.sent || 0;
  const failed = counts.failed || 0;
  const skipped = counts.skipped_invalid || 0;
  const pending = counts.pending || 0;
  const processing = counts.processing || 0;

  const total = sent + failed + skipped + pending + processing;
  const done = sent + failed + skipped;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    total,
    sent,
    failed,
    skipped,
    pending,
    processing,
    done,
    percent,
    finished: TERMINAL_JOB_STATUSES.has(job.status),
  };
}

/**
 * Parse the variable-mapping from the submitted form into an ordered map of
 * template variable position → CSV column name.
 *
 * Accepts either:
 *   - a JSON string in `variablesMap`, e.g. `{"1":"first_name","2":"city"}`, or
 *   - repeated `varColumn` fields (array) where index+1 is the variable
 *     position, e.g. varColumn[0]='first_name' → variable {{1}} ← column
 *     `first_name`.
 *
 * Returns a plain object keyed by the 1-based variable position (as strings) to
 * the CSV column name. Empty mappings return `{}`.
 *
 * @param {object} body Express request body
 * @returns {Object<string,string>}
 */
function parseVariablesMap(body) {
  // Explicit JSON mapping wins if present and parseable.
  if (body.variablesMap) {
    try {
      const parsed =
        typeof body.variablesMap === 'string'
          ? JSON.parse(body.variablesMap)
          : body.variablesMap;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const map = {};
        Object.keys(parsed).forEach((key) => {
          const col = (parsed[key] == null ? '' : String(parsed[key])).trim();
          if (col) map[String(key)] = col;
        });
        return map;
      }
    } catch (_err) {
      // Fall through to the varColumn[] form below.
    }
  }

  // Positional varColumn[] fields (multer/urlencoded array).
  const cols = body.varColumn;
  if (Array.isArray(cols)) {
    const map = {};
    cols.forEach((col, idx) => {
      const name = (col == null ? '' : String(col)).trim();
      if (name) map[String(idx + 1)] = name;
    });
    return map;
  }
  if (typeof cols === 'string' && cols.trim()) {
    return { 1: cols.trim() };
  }

  return {};
}

/**
 * Resolve a single CSV row's template variables from the variable-mapping.
 *
 * For each variable position (1..N) in `variablesMap`, look up the mapped CSV
 * column's value on the row. The result is an ordered object keyed by position
 * (as strings), suitable for persisting as the item's `variables` JSON and for
 * later building Cloud API template `components` in the worker (design §5.1).
 *
 * @param {object} record CSV row (column → value)
 * @param {Object<string,string>} variablesMap position → column name
 * @returns {Object<string,string>|null} resolved position → value, or null when
 *   there is no mapping
 */
function resolveRowVariables(record, variablesMap) {
  const positions = Object.keys(variablesMap);
  if (positions.length === 0) return null;

  const resolved = {};
  positions
    .sort((a, b) => Number(a) - Number(b))
    .forEach((pos) => {
      const column = variablesMap[pos];
      const value = record[column];
      resolved[pos] = value == null ? '' : String(value);
    });
  return resolved;
}

/**
 * GET /bulk — render the job list + create form (Requirement 8.1 list surface,
 * plus the Task 10 create form).
 */
async function getBulkPage(req, res, next) {
  try {
    const jobs = await bulkJobModel.list();
    return res.render('bulk', {
      username: req.session.username,
      jobs,
      created: null,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /bulk — create a bulk send job from an uploaded CSV (Req 6.1, 6.2).
 *
 * Multipart form fields:
 *   - `file`           the recipient CSV (required)
 *   - `templateName`   template to send (required)
 *   - `language`       template language code (required)
 *   - `name`           optional human label for the job
 *   - `phoneColumn`    CSV column holding the number (default `phone`)
 *   - `countryColumn`  optional per-row default-country column
 *   - `defaultCountry` optional form-level default country (ISO alpha-2)
 *   - variable mapping via `variablesMap` (JSON) or `varColumn[]` (positional)
 *   - `format=json`    return JSON instead of re-rendering the page
 *
 * Flow: parse CSV → per-row Tier A (Req 6.2) → resolve per-row variables from
 * the mapping → QueueService.enqueueJob creates the job + items and sets the job
 * running (Req 6.1). Invalid rows are enqueued as `skipped_invalid` and never
 * sent (Req 6.2); counters reflect the skipped count (Req 6.8).
 */
async function postCreateJob(req, res, next) {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'no_file',
        message:
          'No CSV file was uploaded. Attach a .csv file in the "file" field.',
      });
    }

    const templateName = (req.body.templateName || '').toString().trim();
    const language = (req.body.language || '').toString().trim();
    if (!templateName || !language) {
      return res.status(400).json({
        ok: false,
        error: 'missing_template',
        message: 'Template name and language are required to create a bulk job.',
      });
    }

    const name = (req.body.name || '').toString().trim() || null;
    const phoneColumn =
      (req.body.phoneColumn || '').toString().trim() || DEFAULT_PHONE_COLUMN;
    const countryColumn = (req.body.countryColumn || '').toString().trim() || null;
    const defaultCountry =
      (req.body.defaultCountry || '').toString().trim() || null;
    const variablesMap = parseVariablesMap(req.body);

    // Parse CSV (header row → array of column→value objects).
    let records;
    try {
      records = parseCsv(req.file.buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch (parseErr) {
      return res.status(400).json({
        ok: false,
        error: 'parse_error',
        message: `Could not parse the CSV: ${parseErr.message}`,
      });
    }

    if (!records.length) {
      return res.status(400).json({
        ok: false,
        error: 'empty_csv',
        message: 'The CSV contained no data rows.',
      });
    }

    // Ensure the configured phone column exists.
    const header = Object.keys(records[0]);
    if (!header.includes(phoneColumn)) {
      return res.status(400).json({
        ok: false,
        error: 'missing_column',
        message: `CSV has no "${phoneColumn}" column. Columns found: ${header.join(', ')}.`,
      });
    }

    // Per-row Tier A (Req 6.2) + per-row variable resolution.
    const rows = records.map((record) => {
      const rawInput = (record[phoneColumn] == null ? '' : record[phoneColumn])
        .toString()
        .trim();
      const rowCountry =
        countryColumn && record[countryColumn]
          ? record[countryColumn].toString().trim()
          : null;
      const country = rowCountry || defaultCountry || undefined;

      const parsed = phoneService.parse(rawInput, country);
      const variables = resolveRowVariables(record, variablesMap);

      return {
        rawInput,
        toE164: parsed.valid ? parsed.e164 : null,
        variables,
        valid: parsed.valid,
        reason: parsed.reason,
      };
    });

    // Enqueue via the active queue driver (db default, or bullmq when
    // QUEUE_DRIVER=bullmq). Both honor the same enqueueJob contract (design §6):
    // create bulk_jobs + bulk_job_items, set counters, set running. No sending
    // happens here (the worker does that).
    const result = await getDriver().enqueueJob(
      { name, templateName, language, msgType: 'template', variablesMap },
      rows
    );

    const wantsJson =
      (req.body.format || req.query.format) === 'json' ||
      (req.get('accept') || '').includes('application/json');

    if (wantsJson) {
      return res.status(201).json({
        ok: true,
        jobId: result.jobId,
        status: result.status,
        counts: {
          total: result.total,
          pending: result.pending,
          skipped: result.skipped,
        },
        templateName,
        language,
      });
    }

    // Re-render the page with the fresh job list and a created banner.
    const jobs = await bulkJobModel.list();
    return res.status(201).render('bulk', {
      username: req.session.username,
      jobs,
      created: {
        jobId: result.jobId,
        status: result.status,
        total: result.total,
        pending: result.pending,
        skipped: result.skipped,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /bulk/:id — job detail with per-item status, recipient, wamid, and
 * failure reason (Requirement 8.2), plus an optional status filter
 * (Requirement 8.4) and a live progress snapshot the page's poller seeds from
 * (Requirement 8.3).
 *
 * Query params:
 *   - `status` — narrow the item list to a single item status
 *     (pending/processing/sent/failed/skipped_invalid). Unknown values are
 *     ignored (all items shown). Passed to `listByJob` as the filter.
 *
 * Renders `bulk-detail.ejs`. Returns 404 (page) when the job does not exist.
 */
async function getJobDetail(req, res, next) {
  try {
    const job = await bulkJobModel.getById(req.params.id);
    if (!job) {
      res.status(404);
      return res.render('bulk-detail', {
        username: req.session.username,
        job: null,
        items: [],
        counts: null,
        progress: null,
        statusFilter: null,
      });
    }

    // Validate the filter: only a known item status narrows the list; anything
    // else is ignored so the query param can't leak into the SQL as a bad value.
    const requested = (req.query.status || '').toString().trim();
    const statusFilter = ITEM_STATUSES.has(requested) ? requested : null;

    const [items, counts] = await Promise.all([
      bulkJobItemModel.listByJob(job.id, statusFilter ? { status: statusFilter } : {}),
      bulkJobItemModel.countsByStatus(job.id),
    ]);

    const progress = buildProgress(job, counts);

    return res.render('bulk-detail', {
      username: req.session.username,
      job,
      items,
      counts,
      progress,
      statusFilter,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /bulk/:id/progress — JSON progress for client polling (Requirement 8.3).
 *
 * Returns live X-of-Y counts derived from the per-item status counts (not the
 * cached job counters), so the browser's progress bar reflects items as they
 * complete. Shape:
 *   { ok, jobId, status, total, sent, failed, skipped, pending, processing,
 *     done, percent, finished }
 * The client stops polling once `finished` is true (job completed/failed).
 *
 * Returns 404 JSON when the job does not exist.
 */
async function getJobProgress(req, res, next) {
  try {
    const job = await bulkJobModel.getById(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: 'not_found',
        message: `No bulk job with id ${req.params.id}.`,
      });
    }

    const counts = await bulkJobItemModel.countsByStatus(job.id);
    return res.json(buildProgress(job, counts));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /bulk/:id/retry-failed — re-queue a job's failed items (Requirement 8.5,
 * optional stretch). Gated behind a button in the job detail view.
 *
 * Flow:
 *   1. Look up the job; unknown job → 404 (JSON or page).
 *   2. `retryFailed(jobId)` flips `failed` items (guarded `wamid IS NULL`) back
 *      to `pending` with `attempts=0`, `next_attempt_at=NOW()`, cleared error
 *      (the model method). The DB-backed worker (or the BullMQ path — both honor
 *      the same contract) picks them up on the next tick.
 *   3. Adjust the job so the re-queued work resumes: decrement `failed_count` by
 *      the number re-queued (they are no longer failed) and set the job
 *      `running` again so completion detection re-fires once they finish.
 *   4. Respond: JSON when requested, otherwise redirect back to the detail page.
 *
 * CSRF: unlike the multipart bulk-create route, this is a plain state-changing
 * POST (JSON or urlencoded), so the global CSRF middleware reads the normal
 * `_csrf` body field / header — no multipart header workaround needed.
 *
 * @param {object} [deps] injectable models (for tests)
 */
async function postRetryFailed(req, res, next) {
  try {
    const job = await bulkJobModel.getById(req.params.id);

    const wantsJson =
      (req.body && req.body.format) === 'json' ||
      req.query.format === 'json' ||
      (req.get('accept') || '').includes('application/json');

    if (!job) {
      if (wantsJson) {
        return res.status(404).json({
          ok: false,
          error: 'not_found',
          message: `No bulk job with id ${req.params.id}.`,
        });
      }
      res.status(404);
      return res.render('bulk-detail', {
        username: req.session.username,
        job: null,
        items: [],
        counts: null,
        progress: null,
        statusFilter: null,
      });
    }

    // Re-queue failed items (Req 8.5). Guarded against re-sending accepted rows.
    const requeued = await bulkJobItemModel.retryFailed(job.id);

    if (requeued > 0) {
      // The re-queued items are no longer failed → decrement failed_count (never
      // below zero) and put the job back to running so the worker resumes it and
      // completion detection re-fires when they finish (Req 6.8).
      const newFailed = Math.max(0, (Number(job.failed_count) || 0) - requeued);
      await bulkJobModel.updateCounters(job.id, { failedCount: newFailed });
      await bulkJobModel.updateStatus(job.id, 'running');

      // On the BullMQ path, the out-of-process worker must be woken to drain the
      // just-requeued rows (the DB/cron path polls automatically, so it has no
      // enqueueRetry). Same-contract, driver-selected.
      const driver = getDriver();
      if (typeof driver.enqueueRetry === 'function') {
        await driver.enqueueRetry(job.id);
      }
    }

    if (wantsJson) {
      return res.status(200).json({
        ok: true,
        jobId: job.id,
        requeued,
        status: requeued > 0 ? 'running' : job.status,
      });
    }

    return res.redirect(`/bulk/${job.id}`);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getBulkPage,
  postCreateJob,
  getJobDetail,
  getJobProgress,
  postRetryFailed,
  // Exported for testing.
  parseVariablesMap,
  resolveRowVariables,
  buildProgress,
  ITEM_STATUSES,
  DEFAULT_PHONE_COLUMN,
};
