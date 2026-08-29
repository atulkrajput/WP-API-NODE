'use strict';

/**
 * Admin model — data access for the `admins` table (design §3).
 *
 * The MVP has a single seeded admin. This model exposes a lookup by username
 * used by the auth controller during login. Password hashes are never rendered
 * or logged; callers use bcrypt to compare against `password_hash`.
 */

const pool = require('../db/pool');

/**
 * Find an admin by username.
 *
 * @param {string} username
 * @param {import('mysql2/promise').Pool} [db] optional pool (for tests)
 * @returns {Promise<{ id: number, username: string, password_hash: string, created_at: string } | null>}
 */
async function findByUsername(username, db = pool) {
  if (!username) return null;

  const [rows] = await db.execute(
    'SELECT id, username, password_hash, created_at FROM admins WHERE username = ? LIMIT 1',
    [username]
  );

  return rows.length ? rows[0] : null;
}

module.exports = { findByUsername };
