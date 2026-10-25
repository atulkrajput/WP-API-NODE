'use strict';

/**
 * Settings → API keys. One key per project that should use this WhatsApp
 * number. The plaintext key is shown exactly once, right after creation.
 */

const config = require('../config');
const apiClientModel = require('../models/apiClient');

async function getPage(req, res, next) {
  try {
    let clients = [];
    let loadError = null;
    try {
      clients = await apiClientModel.list();
    } catch (err) {
      loadError = 'Could not load API keys. Did you run "npm run migrate"?';
    }
    const newKey = req.session.newApiKey || null;
    delete req.session.newApiKey;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return res.render('api-keys', {
      username: req.session.username,
      clients: clients || [],
      loadError,
      newKey,
      baseUrl,
      senderConfigured: Boolean(config.meta.token && config.meta.phoneNumberId),
      rateLimit: config.api.rateLimitPerMin,
    });
  } catch (err) {
    return next(err);
  }
}

async function postCreate(req, res, next) {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) {
      req.flash('danger', 'Give the key a project name.');
      return res.redirect('/settings/api-keys');
    }
    const created = await apiClientModel.create(name);
    req.session.newApiKey = { name: created.name, key: created.key };
    return res.redirect('/settings/api-keys');
  } catch (err) {
    return next(err);
  }
}

async function postRevoke(req, res, next) {
  try {
    const ok = await apiClientModel.revoke(Number.parseInt(req.params.id, 10));
    req.flash(ok ? 'success' : 'warning', ok ? 'Key revoked. Calls using it now get 401.' : 'Key was already revoked.');
    return res.redirect('/settings/api-keys');
  } catch (err) {
    return next(err);
  }
}

module.exports = { getPage, postCreate, postRevoke };
