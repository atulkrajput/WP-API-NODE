'use strict';

/**
 * Message controller (Requirement 5 — single WhatsApp send).
 *
 * - `getMessagesPage` renders the single-send UI (template/text toggle +
 *   variable inputs), defaulting to template mode (Req 5.1) and clearly
 *   labeling free-text as session-window-only (Req 5.2).
 * - `postSingle` runs a Tier A format check on the recipient BEFORE calling
 *   Meta (Req 5.3); on a valid number it sends via WhatsAppService and persists
 *   a `messages` row — `accepted` + `wamid` on success (Req 5.4), or `failed`
 *   with the Meta error code/message on rejection (Req 5.5).
 * - `getStatus` returns the current stored status as JSON so the admin can poll
 *   for webhook-driven updates (Req 5.6).
 */

const phoneService = require('../services/phoneService');
const whatsappService = require('../services/whatsappService');
const messageModel = require('../models/message');
const config = require('../config');

/** Current UTC time as a MySQL DATETIME string ("YYYY-MM-DD HH:MM:SS"). */
function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Build Cloud API template `components` from ordered variable values
 * (design §5.1). Each non-empty value becomes a body text parameter. Returns an
 * empty array when there are no variables (WhatsAppService omits an empty
 * components list from the payload).
 *
 * @param {Array<string>} variables ordered body variable values
 * @returns {Array<object>} components array
 */
function buildComponents(variables) {
  const values = (Array.isArray(variables) ? variables : [])
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
 * Normalize the `variables` field from a form/JSON body into an ordered array.
 * Accepts an array (`variables[]`) or a single value; ignores empty containers.
 *
 * @param {any} raw
 * @returns {Array<string>}
 */
function normalizeVariables(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === '') return [];
  return [raw];
}

/**
 * Build a short human-readable preview stored on the message row
 * (`body_preview`). For templates it summarizes name + variables; for text it
 * is the (truncated) body.
 *
 * @param {'template'|'text'} msgType
 * @param {{templateName?:string, variables?:Array<string>, body?:string}} parts
 * @returns {string}
 */
function buildPreview(msgType, parts) {
  if (msgType === 'text') {
    return String(parts.body || '').slice(0, 500);
  }
  const vars = (parts.variables || []).filter((v) => String(v).trim() !== '');
  const suffix = vars.length ? ` [${vars.join(', ')}]` : '';
  return `template:${parts.templateName || ''}${suffix}`.slice(0, 500);
}

/** GET /messages — render the single-send page (defaults to template mode). */
function getMessagesPage(req, res) {
  return res.render('messages', {
    username: req.session.username,
    defaultLang: config.probe.templateLang,
  });
}

/**
 * POST /messages/single — send one message (Requirement 5).
 *
 * Body:
 *   { mode: 'template'|'text', to: string, defaultCountry?: string,
 *     templateName?, language?, variables?: string[], body? }
 *
 * Flow: Tier A check → (valid) send via WhatsAppService → persist messages row.
 * On Tier A failure we short-circuit and NEVER call Meta (Req 5.3).
 */
async function postSingle(req, res, next) {
  try {
    const mode = req.body.mode === 'text' ? 'text' : 'template';
    const to = (req.body.to || req.body.number || '').toString();
    const defaultCountry = (req.body.defaultCountry || req.body.country || '')
      .toString()
      .trim();

    // Req 5.3 — validate recipient format (Tier A) BEFORE calling Meta.
    const phone = phoneService.parse(to, defaultCountry || undefined);
    if (!phone.valid) {
      return res.status(400).json({
        ok: false,
        stage: 'validation',
        tier: 'A',
        reason: phone.reason,
        message: `Recipient failed Tier A format validation: ${phone.reason}`,
      });
    }

    const e164 = phone.e164;

    let sendResult;
    let msgType;
    let templateName = null;
    let language = null;
    let variables = [];

    if (mode === 'text') {
      msgType = 'text';
      const body = (req.body.body || '').toString();
      if (!body.trim()) {
        return res.status(400).json({
          ok: false,
          stage: 'validation',
          reason: 'Message body is required for free-text mode.',
          message: 'Message body is required for free-text mode.',
        });
      }
      sendResult = await whatsappService.sendText(e164, body);
    } else {
      msgType = 'template';
      templateName = (req.body.templateName || '').toString().trim();
      language = (req.body.language || '').toString().trim();
      variables = normalizeVariables(req.body.variables).map((v) =>
        v === undefined || v === null ? '' : String(v)
      );

      if (!templateName || !language) {
        return res.status(400).json({
          ok: false,
          stage: 'validation',
          reason: 'Template name and language are required for template mode.',
          message: 'Template name and language are required for template mode.',
        });
      }

      const components = buildComponents(variables);
      sendResult = await whatsappService.sendTemplate(
        e164,
        templateName,
        language,
        components
      );
    }

    const now = utcNow();
    const preview = buildPreview(msgType, {
      templateName,
      language,
      variables,
      body: req.body.body,
    });

    if (sendResult.ok) {
      // Req 5.4 — Meta accepted → persist accepted row with wamid.
      const id = await messageModel.insert({
        wamid: sendResult.wamid || null,
        toE164: e164,
        msgType,
        templateName,
        language,
        bodyPreview: preview,
        status: 'accepted',
        acceptedAt: now,
      });

      return res.status(201).json({
        ok: true,
        id,
        wamid: sendResult.wamid || null,
        status: 'accepted',
        to: e164,
        msgType,
        statusUrl: `/messages/${id}/status`,
      });
    }

    // Req 5.5 — Meta returned an error → persist failed row with error info.
    const id = await messageModel.insert({
      wamid: null,
      toE164: e164,
      msgType,
      templateName,
      language,
      bodyPreview: preview,
      status: 'failed',
      errorCode: sendResult.code || null,
      errorTitle: sendResult.title || null,
      errorDetail: sendResult.detail || null,
      failedAt: now,
    });

    return res.status(502).json({
      ok: false,
      id,
      status: 'failed',
      to: e164,
      msgType,
      error: {
        code: sendResult.code || null,
        title: sendResult.title || null,
        detail: sendResult.detail || null,
      },
      statusUrl: `/messages/${id}/status`,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /messages/:id/status — current status as JSON (Requirement 5.6).
 *
 * Lets the admin poll for webhook-driven status transitions. Returns 404 when
 * the message id is unknown.
 */
async function getStatus(req, res, next) {
  try {
    const row = await messageModel.getById(req.params.id);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    return res.status(200).json({
      ok: true,
      id: row.id,
      wamid: row.wamid,
      to: row.to_e164,
      msgType: row.msg_type,
      status: row.status,
      error: {
        code: row.error_code,
        title: row.error_title,
        detail: row.error_detail,
      },
      timestamps: {
        acceptedAt: row.accepted_at,
        sentAt: row.sent_at,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
        failedAt: row.failed_at,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getMessagesPage,
  postSingle,
  getStatus,
  // Exported for testing.
  buildComponents,
  buildPreview,
};
