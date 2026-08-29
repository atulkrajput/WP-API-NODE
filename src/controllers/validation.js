'use strict';

/**
 * Validation controller (Requirement 2 — Tier A format validation).
 *
 * `getValidatePage` renders the validation UI. `postValidateSingle` runs a
 * single-number Tier A format check via PhoneService, persists the outcome to
 * `validation_results` (check_type='format'), and returns JSON that clearly
 * labels the result as Tier A — explicitly NOT a deliverability confirmation
 * (Requirement 2.5).
 *
 * Later tasks add Tier B (deliverability) and bulk validation handlers here.
 */

const crypto = require('crypto');

const { parse: parseCsv } = require('csv-parse/sync');

const phoneService = require('../services/phoneService');
const whatsappService = require('../services/whatsappService');
const validationResultModel = require('../models/validationResult');
const config = require('../config');

/** Default CSV column that holds the phone number (Requirement 4.1). */
const DEFAULT_PHONE_COLUMN = 'phone';

/** Human-readable label for an accepted Tier B probe (Requirement 3.3). */
const TIER_B_ACCEPTED_LABEL =
  'Accepted for delivery (Tier B — pending webhook confirmation)';

/**
 * Disclaimer surfaced with every Tier B result: final delivery status is
 * asynchronous and only confirmed by a later webhook callback (Requirement 3.5).
 */
const TIER_B_DISCLAIMER =
  'A deliverability check performs a REAL send via the WhatsApp Cloud API and ' +
  'consumes a message (it may incur cost and affect quality rating). "Accepted" ' +
  'only means Meta queued the send — the final delivery status (delivered / ' +
  'read / failed) arrives asynchronously via webhook.';

/** GET /validate — render the validation page. */
function getValidatePage(req, res) {
  return res.render('validate', { username: req.session.username });
}

/** GET /validate/bulk — render the bulk CSV upload form (no report yet). */
function getBulkPage(req, res) {
  return res.render('bulk-validate', { username: req.session.username });
}

/**
 * POST /validate/single — Tier A format check (Requirement 2).
 *
 * Body: { number: string, defaultCountry?: string }
 * Response JSON (both valid and invalid cases are HTTP 200 — the check ran;
 * the number's validity is carried in the payload):
 *   {
 *     tier: 'A',
 *     checkType: 'format',
 *     valid: boolean,
 *     e164, country, type,
 *     reason,           // present when invalid
 *     label,            // "Format valid (Tier A — not a deliverability check)"
 *     deliverability: 'unknown',
 *     disclaimer: '...'  // never claims WhatsApp deliverability (Req 2.5)
 *   }
 */
async function postValidateSingle(req, res, next) {
  try {
    const rawInput = (req.body.number || req.body.phone || '').toString();
    const defaultCountry = (req.body.defaultCountry || req.body.country || '')
      .toString()
      .trim();

    const result = phoneService.parse(rawInput, defaultCountry || undefined);

    // Persist the attempt (Requirement 2.4). Single checks are not part of a
    // bulk batch, so batch_id is NULL.
    await validationResultModel.insert({
      batchId: null,
      rawInput,
      e164: result.e164,
      country: result.country,
      numberType: result.type,
      checkType: 'format',
      isValid: result.valid,
      status: result.valid ? 'valid' : 'invalid',
      reason: result.reason,
      wamid: null,
    });

    // Tier A/B labeling. We never assert WhatsApp deliverability here (Req 2.5).
    return res.status(200).json({
      tier: 'A',
      checkType: 'format',
      valid: result.valid,
      e164: result.e164,
      country: result.country,
      type: result.type,
      reason: result.reason,
      label: result.label,
      deliverability: 'unknown',
      disclaimer:
        'Tier A checks number format only. It does NOT confirm the number is ' +
        'registered on or reachable via WhatsApp — that requires a Tier B ' +
        'deliverability check (a real send).',
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /validate/deliverability — Tier B deliverability probe (Requirement 3).
 *
 * Body: { number: string, defaultCountry?: string }
 *
 * Flow:
 *   1. Run Tier A format validation first. IF the format is invalid, STOP and
 *      report the format error — NEVER call Meta (Requirement 3.1). The attempt
 *      is still persisted as check_type='deliverability', status='invalid' so
 *      the invalid probe is auditable.
 *   2. Format valid → attempt a real send via WhatsAppService using the
 *      configured probe template (Requirement 3.2). This consumes a real send.
 *   3. Meta accepts → persist check_type='deliverability', status='accepted'
 *      with the returned wamid (Requirement 3.3).
 *   4. Meta rejects → persist check_type='deliverability', status='failed' with
 *      the Meta error code/message (Requirement 3.4).
 *
 * Response codes mirror the message send controller:
 *   200 — Tier A failed (check ran, format invalid; no send attempted)
 *   201 — probe accepted by Meta
 *   502 — Meta rejected the probe
 */
async function postValidateDeliverability(req, res, next) {
  try {
    const rawInput = (req.body.number || req.body.phone || '').toString();
    const defaultCountry = (req.body.defaultCountry || req.body.country || '')
      .toString()
      .trim();

    // Req 3.1 — Tier A first. Invalid format short-circuits, never calls Meta.
    const phone = phoneService.parse(rawInput, defaultCountry || undefined);

    if (!phone.valid) {
      await validationResultModel.insert({
        batchId: null,
        rawInput,
        e164: phone.e164,
        country: phone.country,
        numberType: phone.type,
        checkType: 'deliverability',
        isValid: false,
        status: 'invalid',
        reason: phone.reason,
        wamid: null,
      });

      return res.status(200).json({
        ok: false,
        tier: 'B',
        checkType: 'deliverability',
        stage: 'format',
        valid: false,
        e164: phone.e164,
        country: phone.country,
        type: phone.type,
        reason: phone.reason,
        message: `Number failed Tier A format validation: ${phone.reason}`,
        disclaimer: TIER_B_DISCLAIMER,
      });
    }

    const e164 = phone.e164;

    // Req 3.2 — attempt a REAL send using the configured probe template.
    const sendResult = await whatsappService.sendTemplate(
      e164,
      config.probe.templateName,
      config.probe.templateLang,
      []
    );

    if (sendResult.ok) {
      // Req 3.3 — accepted → persist deliverability/accepted with the wamid.
      const id = await validationResultModel.insert({
        batchId: null,
        rawInput,
        e164,
        country: phone.country,
        numberType: phone.type,
        checkType: 'deliverability',
        isValid: true,
        status: 'accepted',
        reason: null,
        wamid: sendResult.wamid || null,
      });

      return res.status(201).json({
        ok: true,
        id,
        tier: 'B',
        checkType: 'deliverability',
        valid: true,
        status: 'accepted',
        e164,
        country: phone.country,
        type: phone.type,
        wamid: sendResult.wamid || null,
        label: TIER_B_ACCEPTED_LABEL,
        disclaimer: TIER_B_DISCLAIMER,
      });
    }

    // Req 3.4 — Meta rejected → persist deliverability/failed with error info.
    const id = await validationResultModel.insert({
      batchId: null,
      rawInput,
      e164,
      country: phone.country,
      numberType: phone.type,
      checkType: 'deliverability',
      isValid: true,
      status: 'failed',
      reason: sendResult.detail || sendResult.title || 'WhatsApp API rejected the send.',
      wamid: null,
    });

    return res.status(502).json({
      ok: false,
      id,
      tier: 'B',
      checkType: 'deliverability',
      valid: true,
      status: 'failed',
      e164,
      country: phone.country,
      type: phone.type,
      error: {
        code: sendResult.code || null,
        title: sendResult.title || null,
        detail: sendResult.detail || null,
      },
      disclaimer: TIER_B_DISCLAIMER,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Build a Tier A validation report from parsed CSV records (Requirement 4).
 *
 * For every row:
 *   - resolve the phone value from `phoneColumn` (default `phone`),
 *   - resolve an optional per-row default country from `countryColumn`, falling
 *     back to the form-level `defaultCountry`,
 *   - run Tier A via PhoneService,
 *   - flag duplicates: the FIRST occurrence of a given E.164 is "kept", every
 *     later identical E.164 is marked `duplicate` (Requirement 4.4).
 *
 * @param {Array<Object>} records CSV rows as column→value objects
 * @param {{ phoneColumn: string, countryColumn?: string|null, defaultCountry?: string|null }} opts
 * @returns {{
 *   rows: Array<Object>,
 *   summary: { total: number, valid: number, invalid: number, kept: number, duplicate: number }
 * }}
 */
function buildReport(records, opts) {
  const phoneColumn = opts.phoneColumn || DEFAULT_PHONE_COLUMN;
  const countryColumn = opts.countryColumn || null;
  const formDefaultCountry = (opts.defaultCountry || '').toString().trim() || null;

  const seenE164 = new Set();
  const rows = [];
  const summary = { total: 0, valid: 0, invalid: 0, kept: 0, duplicate: 0 };

  records.forEach((record, idx) => {
    const rawInput = (record[phoneColumn] == null ? '' : record[phoneColumn])
      .toString()
      .trim();
    const rowCountry = countryColumn && record[countryColumn]
      ? record[countryColumn].toString().trim()
      : null;
    const defaultCountry = rowCountry || formDefaultCountry || undefined;

    const parsed = phoneService.parse(rawInput, defaultCountry);

    // Duplicate detection only applies to numbers that produced an E.164.
    let duplicate = false;
    if (parsed.valid && parsed.e164) {
      if (seenE164.has(parsed.e164)) {
        duplicate = true;
      } else {
        seenE164.add(parsed.e164);
      }
    }

    summary.total += 1;
    if (parsed.valid) {
      summary.valid += 1;
      if (duplicate) summary.duplicate += 1;
      else summary.kept += 1;
    } else {
      summary.invalid += 1;
    }

    rows.push({
      row: idx + 1, // 1-based data row (header excluded)
      input: rawInput,
      e164: parsed.e164,
      country: parsed.country,
      type: parsed.type,
      valid: parsed.valid,
      duplicate,
      reason: parsed.reason,
    });
  });

  return { rows, summary };
}

/**
 * POST /validate/bulk — bulk Tier A CSV validation (Requirement 4).
 *
 * Expects a multipart/form-data upload with a `file` field (the CSV) and
 * optional text fields:
 *   - `phoneColumn`    (default `phone`)          Requirement 4.1
 *   - `countryColumn`  (optional per-row country) Requirement 4.1
 *   - `defaultCountry` (optional form-level fallback)
 *   - `format=json`    return JSON instead of the rendered report
 *   - `download=1`     return the report as a downloadable CSV attachment
 *
 * CSRF: because the body is multipart/form-data, the global CSRF middleware
 * (which runs BEFORE multer parses the body) cannot see a `_csrf` form field.
 * The upload therefore sends the token via the `x-csrf-token` HEADER, which the
 * CSRF middleware reads directly off the request. This is documented on the
 * route and in the upload view's fetch() call.
 *
 * File guards (Requirement 4.3): size is capped by multer (`config.upload.
 * maxBytes`) at the route; MIME/extension is checked in the route's fileFilter.
 * A missing/rejected file surfaces here as HTTP 400 with a clear message.
 *
 * Tier B is intentionally NOT offered here (Requirement 4.5) — deliverability
 * for bulk is only reachable via the bulk SEND flow (Requirement 6).
 */
async function postValidateBulk(req, res, next) {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'no_file',
        message:
          'No CSV file was uploaded. Attach a .csv file in the "file" field.',
      });
    }

    const phoneColumn =
      (req.body.phoneColumn || '').toString().trim() || DEFAULT_PHONE_COLUMN;
    const countryColumn = (req.body.countryColumn || '').toString().trim() || null;
    const defaultCountry = (req.body.defaultCountry || '').toString().trim() || null;

    // Parse CSV with a header row → array of column→value objects.
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

    // Ensure the configured phone column actually exists in the header.
    const header = Object.keys(records[0]);
    if (!header.includes(phoneColumn)) {
      return res.status(400).json({
        ok: false,
        error: 'missing_column',
        message: `CSV has no "${phoneColumn}" column. Columns found: ${header.join(', ')}.`,
      });
    }

    const { rows, summary } = buildReport(records, {
      phoneColumn,
      countryColumn,
      defaultCountry,
    });

    // Req 4.6 — persist every row under one upload batch id.
    const batchId = crypto.randomUUID();
    await validationResultModel.insertMany(
      rows.map((r) => ({
        batchId,
        rawInput: r.input,
        e164: r.e164,
        country: r.country,
        numberType: r.type,
        checkType: 'format',
        isValid: r.valid,
        status: r.valid ? 'valid' : 'invalid',
        reason: r.duplicate ? `duplicate of an earlier row (${r.reason || 'valid'})` : r.reason,
        wamid: null,
      }))
    );

    // Downloadable CSV report (Requirement 4.2).
    if ((req.body.download || req.query.download) === '1') {
      const csv = reportToCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="validation-report-${batchId}.csv"`
      );
      return res.status(200).send(csv);
    }

    // JSON report (used by tests and programmatic callers).
    const wantsJson =
      (req.body.format || req.query.format) === 'json' ||
      (req.get('accept') || '').includes('application/json');
    if (wantsJson) {
      return res.status(200).json({
        ok: true,
        tier: 'A',
        checkType: 'format',
        batchId,
        phoneColumn,
        countryColumn,
        summary,
        rows,
      });
    }

    // Rendered HTML report (Requirement 4.2).
    return res.status(200).render('bulk-validate', {
      username: req.session.username,
      report: { batchId, phoneColumn, countryColumn, summary, rows },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Serialize a report's rows to CSV text (Requirement 4.2 downloadable report).
 * Header: row,input,e164,country,type,valid,duplicate,reason.
 */
function reportToCsv(rows) {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'row,input,e164,country,type,valid,duplicate,reason';
  const lines = rows.map((r) =>
    [
      r.row,
      escape(r.input),
      escape(r.e164),
      escape(r.country),
      escape(r.type),
      r.valid ? 'true' : 'false',
      r.duplicate ? 'true' : 'false',
      escape(r.reason),
    ].join(',')
  );
  return [header, ...lines].join('\n');
}

module.exports = {
  getValidatePage,
  getBulkPage,
  postValidateSingle,
  postValidateDeliverability,
  postValidateBulk,
  // Exported for testing.
  buildReport,
  reportToCsv,
  TIER_B_ACCEPTED_LABEL,
  TIER_B_DISCLAIMER,
};
