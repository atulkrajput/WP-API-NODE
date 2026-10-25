'use strict';

/**
 * Settings → API keys. One key per project that should use this WhatsApp
 * number. The plaintext key is shown exactly once, right after creation.
 */

const config = require('../config');
const apiClientModel = require('../models/apiClient');
const callbackDeliveryModel = require('../models/callbackDelivery');
const callbackService = require('../services/callbackService');

/** Validate a callback URL. Returns an error string or null. */
function callbackUrlError(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return 'Callback URL is not a valid URL.';
  }
  if (!['https:', 'http:'].includes(u.protocol)) return 'Callback URL must start with https://';
  if (config.isProd && u.protocol !== 'https:') return 'Callback URL must use https:// in production.';
  if (raw.length > 500) return 'Callback URL is too long (max 500 characters).';
  return null;
}

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

function clientId(req) {
  return Number.parseInt(req.params.id, 10);
}

/** GET /settings/api-keys/:id — callback settings + recent deliveries. */
async function getDetail(req, res, next) {
  try {
    const client = await apiClientModel.getById(clientId(req));
    if (!client) {
      req.flash('warning', 'API key not found.');
      return res.redirect('/settings/api-keys');
    }
    let deliveries = [];
    try {
      deliveries = await callbackDeliveryModel.listByClient(client.id, { limit: 25 });
    } catch (e) {
      deliveries = [];
    }
    // Note: `client` is a reserved EJS option name, so pass it as `project`.
    return res.render('api-key-detail', {
      username: req.session.username,
      project: client,
      deliveries: deliveries || [],
    });
  } catch (err) {
    return next(err);
  }
}

/** POST /settings/api-keys/:id/callback — set or clear the callback URL. */
async function postCallback(req, res, next) {
  try {
    const id = clientId(req);
    const url = String((req.body && req.body.callbackUrl) || '').trim();
    if (url) {
      const error = callbackUrlError(url);
      if (error) {
        req.flash('danger', error);
        return res.redirect(`/settings/api-keys/${id}`);
      }
    }
    await apiClientModel.setCallbackUrl(id, url || null);
    req.flash('success', url ? 'Callback URL saved. Use “Send test event” to check it.' : 'Callbacks turned off.');
    return res.redirect(`/settings/api-keys/${id}`);
  } catch (err) {
    return next(err);
  }
}

/** POST /settings/api-keys/:id/rotate-secret */
async function postRotateSecret(req, res, next) {
  try {
    const id = clientId(req);
    await apiClientModel.rotateSecret(id);
    req.flash('warning', 'Signing secret rotated. Update it in the project now; old signatures stop verifying.');
    return res.redirect(`/settings/api-keys/${id}`);
  } catch (err) {
    return next(err);
  }
}

/** POST /settings/api-keys/:id/test — queue a ping event. */
async function postTest(req, res, next) {
  try {
    const id = clientId(req);
    const deliveryId = await callbackService.enqueue(id, 'ping', { message: 'Test event from WhatsApp Hub' });
    req.flash(
      deliveryId ? 'info' : 'warning',
      deliveryId ? 'Test event queued. Refresh in a few seconds to see the result.' : 'Set a callback URL first (and make sure the key is active).'
    );
    return res.redirect(`/settings/api-keys/${id}`);
  } catch (err) {
    return next(err);
  }
}

/** POST /settings/api-keys/:id/deliveries/:did/retry */
async function postRetryDelivery(req, res, next) {
  try {
    const id = clientId(req);
    const ok = await callbackDeliveryModel.retry(Number.parseInt(req.params.did, 10), id);
    req.flash(ok ? 'info' : 'warning', ok ? 'Redelivery queued.' : 'Only failed deliveries can be retried.');
    return res.redirect(`/settings/api-keys/${id}`);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getPage, postCreate, postRevoke, getDetail, postCallback, postRotateSecret, postTest,
  postRetryDelivery, callbackUrlError,
};
