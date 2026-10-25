'use strict';

/**
 * API-key authentication + per-key rate limit for /api/v1.
 *
 * Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`. On success sets
 * `req.apiClient = { id, name }`. The limiter is in-memory (fixed 60s window),
 * which is fine for a single Node process; move it to Redis if you scale out.
 */

const config = require('../config');
const apiClientModel = require('../models/apiClient');

const windows = new Map(); // clientId -> { start, count }

function keyFromRequest(req) {
  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.get('x-api-key') || '').trim() || null;
}

function overLimit(clientId) {
  const limit = config.api.rateLimitPerMin;
  if (!limit || limit <= 0) return false;
  const now = Date.now();
  const w = windows.get(clientId);
  if (!w || now - w.start >= 60000) {
    windows.set(clientId, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > limit;
}

async function requireApiKey(req, res, next) {
  try {
    const key = keyFromRequest(req);
    if (!key) {
      return res.status(401).json({ ok: false, error: 'missing_api_key', message: 'Send your key as "Authorization: Bearer <key>".' });
    }
    const client = await apiClientModel.findActiveByKey(key);
    if (!client) {
      return res.status(401).json({ ok: false, error: 'invalid_api_key', message: 'API key is invalid or revoked.' });
    }
    if (overLimit(client.id)) {
      res.set('Retry-After', '60');
      return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many requests. Retry in a minute.' });
    }
    req.apiClient = { id: client.id, name: client.name };
    apiClientModel.touch(client.id).catch(() => {});
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireApiKey, keyFromRequest, _windows: windows };
