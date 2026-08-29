'use strict';

/**
 * Dashboard controller (Task 13 — dashboard views polish + wiring).
 *
 * `getDashboard` renders the authenticated landing page with an at-a-glance
 * summary the admin can act on:
 *   - recent validations (Tier A format / Tier B deliverability) — Req 2, 3
 *   - recent messages (single/bulk outbound sends + current status) — Req 5
 *   - active bulk jobs (pending/running) — Req 6/8
 *
 * The summary reads are best-effort: a failure in any single panel's query
 * (e.g. a transient DB hiccup) must not blow up the whole dashboard. Each read
 * is guarded so the page still renders with the panels that succeeded and a
 * plain, human-readable notice for the rest — never a stack trace (NFR-2).
 */

const validationResultModel = require('../models/validationResult');
const messageModel = require('../models/message');
const bulkJobModel = require('../models/bulkJob');

/** How many rows each summary panel shows. */
const RECENT_LIMIT = 8;

/**
 * Run a summary read, returning its rows on success or an empty list on
 * failure. A failure is recorded in `errors` so the view can show a neutral
 * "couldn't load" notice for just that panel (NFR-2: no stack traces leak).
 *
 * @param {string} label panel name for the error notice
 * @param {() => Promise<Array<object>>} fn the read to attempt
 * @param {Array<string>} errors accumulator of failed-panel labels
 * @returns {Promise<Array<object>>}
 */
async function safeRead(label, fn, errors) {
  try {
    const rows = await fn();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    errors.push(label);
    return [];
  }
}

/**
 * GET / — render the dashboard summary (Task 13).
 *
 * Loads the three summary panels in parallel, each guarded independently, and
 * renders `dashboard.ejs` with the data plus any per-panel load errors.
 */
async function getDashboard(req, res, next) {
  try {
    const errors = [];

    const [recentValidations, recentMessages, activeJobs] = await Promise.all([
      safeRead(
        'recent validations',
        () => validationResultModel.recent({ limit: RECENT_LIMIT }),
        errors
      ),
      safeRead(
        'recent messages',
        () => messageModel.recent({ limit: RECENT_LIMIT }),
        errors
      ),
      safeRead(
        'active jobs',
        () => bulkJobModel.listActive({ limit: RECENT_LIMIT }),
        errors
      ),
    ]);

    return res.render('dashboard', {
      username: req.session.username,
      recentValidations,
      recentMessages,
      activeJobs,
      summaryErrors: errors,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getDashboard, RECENT_LIMIT };
