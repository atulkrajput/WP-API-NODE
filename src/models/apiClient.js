'use strict';

/**
 * API client model — one row per project allowed to call /api/v1.
 *
 * Keys look like `wak_<43 url-safe chars>`. Only sha256(key) is stored, so a
 * DB leak does not expose usable keys. Keys are high-entropy random values, so
 * a plain (unsalted) sha256 is sufficient and keeps lookups O(1).
 */

const crypto = require('crypto');
const pool = require('../db/pool');

const KEY_PREFIX = 'wak_';

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a client and return its plaintext key (shown once, never stored).
 * @returns {Promise<{id:number, name:string, key:string, keyPrefix:string}>}
 */
async function create(name, db = pool) {
  const key = generateKey();
  const keyPrefix = key.slice(0, 12);
  const [result] = await db.execute(
    'INSERT INTO api_clients (name, key_prefix, key_hash) VALUES (?, ?, ?)',
    [String(name).slice(0, 120), keyPrefix, hashKey(key)]
  );
  return { id: result.insertId, name, key, keyPrefix };
}

/** Resolve an active client from a presented key, or null. */
async function findActiveByKey(key, db = pool) {
  if (!key || typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return null;
  const [rows] = await db.execute(
    'SELECT id, name, key_prefix FROM api_clients WHERE key_hash = ? AND is_active = 1 LIMIT 1',
    [hashKey(key)]
  );
  return rows[0] || null;
}

/** Best-effort last-used timestamp. */
async function touch(id, db = pool) {
  await db.execute('UPDATE api_clients SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
}

/** All clients with 30-day message counts, newest first. */
async function list(db = pool) {
  const [rows] = await db.query(
    `SELECT c.id, c.name, c.key_prefix, c.callback_url, c.is_active, c.last_used_at, c.revoked_at, c.created_at,
            (SELECT COUNT(*) FROM messages m
              WHERE m.api_client_id = c.id
                AND m.created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY) AS messages_30d
       FROM api_clients c
      ORDER BY c.is_active DESC, c.id DESC`
  );
  return rows;
}

/** Revoke a key. Returns true when a row changed. */
async function revoke(id, db = pool) {
  const [result] = await db.execute(
    'UPDATE api_clients SET is_active = 0, revoked_at = UTC_TIMESTAMP() WHERE id = ? AND is_active = 1',
    [id]
  );
  return result.affectedRows > 0;
}

/** One client (admin detail page). Includes callback settings. */
async function getById(id, db = pool) {
  const [rows] = await db.execute(
    `SELECT id, name, key_prefix, callback_url, callback_secret, is_active,
            last_used_at, revoked_at, created_at
       FROM api_clients WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/** Callback settings used when enqueueing events. */
async function getCallback(id, db = pool) {
  const [rows] = await db.execute(
    'SELECT id, callback_url, callback_secret, is_active FROM api_clients WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

/** Set (or clear) the callback URL. Generates a signing secret on first set. */
async function setCallbackUrl(id, url, db = pool) {
  await db.execute(
    `UPDATE api_clients
        SET callback_url = ?,
            callback_secret = COALESCE(callback_secret, ?)
      WHERE id = ?`,
    [url || null, generateSecret(), id]
  );
}

/** Replace the signing secret. Returns the new value. */
async function rotateSecret(id, db = pool) {
  const secret = generateSecret();
  await db.execute('UPDATE api_clients SET callback_secret = ? WHERE id = ?', [secret, id]);
  return secret;
}

function generateSecret() {
  return 'whsec_' + crypto.randomBytes(24).toString('base64url');
}

module.exports = { getById, getCallback, setCallbackUrl, rotateSecret, create, findActiveByKey, touch, list, revoke, hashKey, generateKey, KEY_PREFIX };
