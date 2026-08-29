'use strict';

/**
 * Thin migration runner (no ORM — design §2).
 *
 * Behaviour:
 *  1. Connect to the MySQL server (without selecting a database) and
 *     `CREATE DATABASE IF NOT EXISTS` the configured schema.
 *  2. Connect to that database and ensure a `schema_migrations` bookkeeping
 *     table exists.
 *  3. Read every `*.sql` file in `./migrations`, sorted by filename, and apply
 *     any that have not been recorded yet — each inside a transaction, recorded
 *     in `schema_migrations` so re-running is a no-op.
 *
 * Usage: `npm run migrate`
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { createMigrationPool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Return migration filenames (*.sql) sorted lexicographically. */
function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort();
}

/** Ensure the target database exists, then bind the pool's connections to it. */
async function ensureDatabase(pool) {
  const dbName = config.db.database;
  // Identifier can't be parameterized; it comes from config, not user input.
  await pool.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` ` +
      'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  );
  await pool.query(`USE \`${dbName}\``);
}

/** Ensure the bookkeeping table used to track applied migrations exists. */
async function ensureMigrationsTable(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       VARCHAR(255) PRIMARY KEY,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

/** Fetch the set of already-applied migration names. */
async function appliedMigrations(pool) {
  const [rows] = await pool.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

/**
 * Apply a single migration file within a transaction and record it.
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} file  migration filename (relative to MIGRATIONS_DIR)
 */
async function applyMigration(pool, file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // The pool is created with multipleStatements: true so a whole file runs.
    await conn.query(sql);
    await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Run all pending migrations. Returns the list of applied filenames. */
async function run() {
  const files = listMigrationFiles();
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No migration files found in', MIGRATIONS_DIR);
    return [];
  }

  const pool = createMigrationPool();
  const justApplied = [];
  try {
    await ensureDatabase(pool);
    await ensureMigrationsTable(pool);
    const done = await appliedMigrations(pool);

    for (const file of files) {
      if (done.has(file)) {
        // eslint-disable-next-line no-console
        console.log(`= skip ${file} (already applied)`);
        continue;
      }
      // eslint-disable-next-line no-console
      console.log(`+ apply ${file} ...`);
      await applyMigration(pool, file);
      justApplied.push(file);
    }

    // eslint-disable-next-line no-console
    console.log(
      justApplied.length
        ? `Migrations complete. Applied ${justApplied.length} file(s).`
        : 'Migrations complete. Nothing to apply.'
    );
    return justApplied;
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (npm run migrate).
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = run;
module.exports.listMigrationFiles = listMigrationFiles;
