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
const config = require('../config');

/**
 * Go-live checklist from config. Booleans only — never expose secret values.
 */
function setupChecks() {
  const m = config.meta;
  return [
    { label: 'Access token (WHATSAPP_TOKEN)', ok: Boolean(m.token), hint: 'Use a permanent System User token, not the 24h temporary one.' },
    { label: 'Phone number ID (PHONE_NUMBER_ID)', ok: Boolean(m.phoneNumberId), hint: 'The numeric ID from WhatsApp → API Setup, not the phone number.' },
    { label: 'Business account ID (WABA_ID)', ok: Boolean(m.wabaId), hint: 'Needed for template sync and account calls.' },
    { label: 'App secret (APP_SECRET)', ok: Boolean(m.appSecret), hint: 'Without it every webhook is rejected, so statuses never update.' },
    { label: 'Webhook verify token', ok: Boolean(m.webhookVerifyToken), hint: 'Must match the token entered in Meta → WhatsApp → Configuration.' },
    { label: 'Session secret', ok: config.session.secret !== 'change-me-in-env', hint: 'Set SESSION_SECRET to a long random string.' },
  ];
}

/** Turn [{status, c}] rows into KPI numbers. */
function buildKpis(rows) {
  const by = {};
  (rows || []).forEach((r) => { by[r.status] = Number(r.c) || 0; });
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const delivered = (by.delivered || 0) + (by.read || 0);
  const failed = by.failed || 0;
  const settled = delivered + failed;
  return {
    total,
    delivered,
    read: by.read || 0,
    failed,
    inFlight: (by.accepted || 0) + (by.sent || 0),
    deliveryRate: settled > 0 ? Math.round((delivered / settled) * 100) : null,
  };
}

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

    const [recentValidations, recentMessages, activeJobs, counts] = await Promise.all([
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
      safeRead('message stats', () => messageModel.statusCounts({ days: 30 }), errors),
    ]);

    const checks = setupChecks();

    return res.render('dashboard', {
      username: req.session.username,
      recentValidations,
      recentMessages,
      activeJobs,
      summaryErrors: errors,
      kpis: buildKpis(counts),
      setupChecks: checks,
      setupDone: checks.every((c) => c.ok),
      webhookUrl: `${req.protocol}://${req.get('host')}/webhook`,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getDashboard, RECENT_LIMIT, buildKpis, setupChecks };
