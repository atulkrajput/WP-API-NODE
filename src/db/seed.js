'use strict';

/**
 * Seed the single MVP admin user (design §2, Requirement 1.5).
 *
 * Reads `ADMIN_USERNAME` / `ADMIN_PASSWORD` from config (env only — never
 * committed) and inserts an `admins` row with a bcrypt password hash. The
 * password is never stored in plaintext.
 *
 * Idempotent: re-running updates the existing admin's hash rather than creating
 * duplicates (username is UNIQUE). Requires the schema to exist — run
 * `npm run migrate` first.
 *
 * Usage: `npm run seed`
 */

const bcrypt = require('bcryptjs');

const config = require('../config');
const pool = require('./pool');

const BCRYPT_ROUNDS = 10;

/**
 * Insert or update the admin row.
 * @param {import('mysql2/promise').Pool} db
 * @returns {Promise<{ username: string, created: boolean }>}
 */
async function seedAdmin(db) {
  const { username, password } = config.admin;

  if (!password) {
    throw new Error(
      'ADMIN_PASSWORD is not set. Set it in your environment before seeding.'
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // Upsert: if the username already exists, refresh the hash. This keeps the
  // seed idempotent without ever creating a second admin row.
  const [result] = await db.execute(
    `INSERT INTO admins (username, password_hash)
       VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [username, passwordHash]
  );

  // affectedRows === 1 → inserted; === 2 → updated existing row (MySQL semantics).
  const created = result.affectedRows === 1;
  return { username, created };
}

/** Run the seed and close the pool. */
async function run() {
  try {
    const { username, created } = await seedAdmin(pool);
    // eslint-disable-next-line no-console
    console.log(
      created
        ? `Seeded admin user "${username}".`
        : `Admin user "${username}" already existed — password hash refreshed.`
    );
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (npm run seed).
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}

module.exports = run;
module.exports.seedAdmin = seedAdmin;
