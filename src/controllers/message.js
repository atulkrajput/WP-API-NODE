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

const messageService = require('../services/messageService');
const messageModel = require('../models/message');
const config = require('../config');

const { buildComponents, buildPreview } = messageService;

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
    const b = req.body || {};
    const result = await messageService.sendOne({
      mode: b.mode,
      to: b.to || b.number,
      defaultCountry: b.defaultCountry || b.country,
      templateName: b.templateName,
      language: b.language,
      variables: b.variables,
      body: b.body,
    });
    const out = { ...result.body };
    if (out.id) out.statusUrl = `/messages/${out.id}/status`;
    return res.status(result.status).json(out);
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
