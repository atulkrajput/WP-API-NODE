'use strict';

/**
 * Public REST API v1 — lets any of your projects use this WhatsApp number.
 *
 * Auth: `Authorization: Bearer <api key>` (create keys in Settings → API keys
 * or with `npm run apikey -- create "Project name"`).
 *
 *   GET  /api/v1/me                → which key/project you are
 *   POST /api/v1/validate          → Tier A format check (free, no send)
 *   POST /api/v1/messages          → send a template or text message
 *   GET  /api/v1/messages/:id      → status of a message this key sent
 */

const express = require('express');

const config = require('../config');
const phoneService = require('../services/phoneService');
const messageService = require('../services/messageService');
const messageModel = require('../models/message');
const { requireApiKey } = require('../middleware/apiAuth');

const router = express.Router();

router.use(requireApiKey);

router.get('/me', (req, res) => {
  res.json({
    ok: true,
    client: req.apiClient,
    sender: { configured: Boolean(config.meta.token && config.meta.phoneNumberId) },
  });
});

router.post('/validate', (req, res) => {
  const b = req.body || {};
  const number = String(b.number || b.to || '');
  if (!number.trim()) {
    return res.status(400).json({ ok: false, error: 'number_required', message: '"number" is required.' });
  }
  const r = phoneService.parse(number, String(b.defaultCountry || '').trim() || undefined);
  return res.json({
    ok: true,
    valid: r.valid,
    e164: r.e164 || null,
    country: r.country || null,
    type: r.type || null,
    reason: r.valid ? null : r.reason,
    note: 'Format check only. WhatsApp reachability is confirmed only by a real send.',
  });
});

/**
 * Body:
 * {
 *   "to": "+919876543210",
 *   "type": "template" | "text",          // default: template
 *   "template": { "name": "order_update", "language": "en_US", "variables": ["Asha", "#123"] },
 *   "text": "Hi!",                         // only for type=text (24h window only)
 *   "defaultCountry": "IN",                // optional, for numbers without +CC
 *   "reference": "order-123"               // optional, your own id
 * }
 */
router.post('/messages', async (req, res, next) => {
  try {
    const b = req.body || {};
    const tpl = b.template && typeof b.template === 'object' ? b.template : {};
    const result = await messageService.sendOne({
      mode: b.type === 'text' ? 'text' : 'template',
      to: b.to,
      defaultCountry: b.defaultCountry,
      templateName: tpl.name || b.templateName,
      language: tpl.language || b.language || config.probe.templateLang,
      variables: tpl.variables || b.variables,
      body: b.text,
      apiClientId: req.apiClient.id,
      clientRef: b.reference,
    });
    const out = { ...result.body };
    if (b.reference) out.reference = String(b.reference).slice(0, 120);
    return res.status(result.status).json(out);
  } catch (err) {
    return next(err);
  }
});

router.get('/messages/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ ok: false, error: 'not_found' });
    const row = await messageModel.getByIdForClient(id, req.apiClient.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, message: messageService.serialize(row) });
  } catch (err) {
    return next(err);
  }
});

// JSON-only errors for API callers (never HTML, never stack traces). Exported
// so app.js can also mount it after the body parser (parse errors skip routers).
// eslint-disable-next-line no-unused-vars
function apiErrorHandler(err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  if (config.env !== 'test') {
    // eslint-disable-next-line no-console
    console.error('[api error]', req.method, req.originalUrl, err && err.message);
  }
  return res.status(500).json({ ok: false, error: 'internal_error' });
}

router.use(apiErrorHandler);

module.exports = router;
module.exports.apiErrorHandler = apiErrorHandler;
