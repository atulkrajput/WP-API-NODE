'use strict';

/**
 * MessageService — the one send path shared by the admin UI and /api/v1.
 *
 * Flow: Tier A format check → WhatsApp Cloud API send → persist a `messages`
 * row (accepted + wamid, or failed + Meta error). Returns an HTTP status plus a
 * JSON-ready body so each caller only shapes the transport.
 */

const phoneService = require('./phoneService');
const whatsappService = require('./whatsappService');
const messageModel = require('../models/message');

function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Ordered variable values → Cloud API body components ([] when none). */
function buildComponents(variables) {
  const values = (Array.isArray(variables) ? variables : [])
    .map((v) => (v === undefined || v === null ? '' : String(v)))
    .filter((v) => v.trim() !== '');
  if (values.length === 0) return [];
  return [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }];
}

/** Accept an array or a single value; ignore empties. */
function normalizeVariables(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === '') return [];
  return [raw];
}

/** Short preview stored on the row. */
function buildPreview(msgType, parts) {
  if (msgType === 'text') return String(parts.body || '').slice(0, 500);
  const vars = (parts.variables || []).filter((v) => String(v).trim() !== '');
  const suffix = vars.length ? ` [${vars.join(', ')}]` : '';
  return `template:${parts.templateName || ''}${suffix}`.slice(0, 500);
}

function invalid(reason, extra) {
  return { status: 400, body: { ok: false, stage: 'validation', reason, message: reason, ...extra } };
}

/**
 * Send one message.
 *
 * @param {{
 *   mode: 'template'|'text', to: string, defaultCountry?: string,
 *   templateName?: string, language?: string, variables?: string[], body?: string,
 *   apiClientId?: number|null, clientRef?: string|null,
 * }} input
 * @returns {Promise<{status:number, body:object}>}
 */
async function sendOne(input) {
  const mode = input.mode === 'text' ? 'text' : 'template';
  const to = String(input.to || '');
  const defaultCountry = String(input.defaultCountry || '').trim();

  // Tier A before ever calling Meta.
  const phone = phoneService.parse(to, defaultCountry || undefined);
  if (!phone.valid) {
    return {
      status: 400,
      body: {
        ok: false,
        stage: 'validation',
        tier: 'A',
        reason: phone.reason,
        message: `Recipient failed Tier A format validation: ${phone.reason}`,
      },
    };
  }
  const e164 = phone.e164;

  let sendResult;
  let msgType;
  let templateName = null;
  let language = null;
  let variables = [];
  const body = String(input.body || '');

  if (mode === 'text') {
    msgType = 'text';
    if (!body.trim()) return invalid('Message body is required for free-text mode.');
    if (body.length > 4096) return invalid('Message body exceeds 4096 characters.');
    sendResult = await whatsappService.sendText(e164, body);
  } else {
    msgType = 'template';
    templateName = String(input.templateName || '').trim();
    language = String(input.language || '').trim();
    variables = normalizeVariables(input.variables).map((v) =>
      v === undefined || v === null ? '' : String(v)
    );
    if (!templateName || !language) {
      return invalid('Template name and language are required for template mode.');
    }
    sendResult = await whatsappService.sendTemplate(
      e164,
      templateName,
      language,
      buildComponents(variables)
    );
  }

  const now = utcNow();
  const row = {
    toE164: e164,
    msgType,
    templateName,
    language,
    bodyPreview: buildPreview(msgType, { templateName, variables, body }),
  };
  if (input.apiClientId) {
    row.apiClientId = input.apiClientId;
    row.clientRef = input.clientRef ? String(input.clientRef).slice(0, 120) : null;
  }

  if (sendResult.ok) {
    const id = await messageModel.insert({
      ...row,
      wamid: sendResult.wamid || null,
      status: 'accepted',
      acceptedAt: now,
    });
    return {
      status: 201,
      body: { ok: true, id, wamid: sendResult.wamid || null, status: 'accepted', to: e164, msgType },
    };
  }

  const id = await messageModel.insert({
    ...row,
    wamid: null,
    status: 'failed',
    errorCode: sendResult.code || null,
    errorTitle: sendResult.title || null,
    errorDetail: sendResult.detail || null,
    failedAt: now,
  });
  return {
    status: 502,
    body: {
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
    },
  };
}

/** Public, JSON-safe view of a stored message row. */
function serialize(row) {
  return {
    id: row.id,
    wamid: row.wamid,
    to: row.to_e164,
    msgType: row.msg_type,
    template: row.template_name || null,
    reference: row.client_ref || null,
    status: row.status,
    error: row.error_code || row.error_title
      ? { code: row.error_code, title: row.error_title, detail: row.error_detail }
      : null,
    timestamps: {
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      sentAt: row.sent_at,
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
      failedAt: row.failed_at,
    },
  };
}

module.exports = { sendOne, serialize, buildComponents, buildPreview, normalizeVariables };
