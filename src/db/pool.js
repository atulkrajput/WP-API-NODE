'use strict';

/**
 * MySQL connection pool (mysql2/promise).
 *
 * A single shared pool is created for the whole app. Callers use
 * `pool.query(...)` / `pool.execute(...)` and receive promises.
 *
 * Design notes (design §2, §3):
 * - Timestamps are stored in UTC. We force the connection session timezone to
 *   UTC (`timezone: 'Z'`) so DATETIME values written/read by the driver are not
 *   silently shifted by the server's local zone.
 * - `dateStrings: true` keeps DATETIME columns as plain strings, avoiding
 *   accidental local-timezone conversion when the driver builds JS Date objects.
 */

const mysql = require('mysql2/promise');
const config = require('../config');

/**
 * Build the pool options from central config. `database` is optional so the
 * migration runner can connect to the server first and create the schema if it
 * does not yet exist.
 *
 * @param {{ withDatabase?: boolean }} [opts]
 * @returns {import('mysql2/promise').PoolOptions}
 */
function buildOptions(opts = {}) {
  const { withDatabase = true } = opts;
  const options = {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Store/interpret DATETIME as UTC (design §3: all timestamps in UTC).
    timezone: 'Z',
    dateStrings: true,
    // Allow multiple statements in one query — used by the migration runner to
    // execute a whole .sql file. Regular app queries should NOT rely on this.
    multipleStatements: false,
  };
  if (withDatabase) {
    options.database = config.db.database;
  }
  return options;
}

// The application-wide pool (bound to the configured database).
const pool = mysql.createPool(buildOptions({ withDatabase: true }));

/**
 * Create a one-off pool that permits multiple statements per query and is not
 * yet bound to a database. Used only by the migration runner.
 *
 * @returns {import('mysql2/promise').Pool}
 */
function createMigrationPool() {
  return mysql.createPool({
    ...buildOptions({ withDatabase: false }),
    multipleStatements: true,
  });
}

module.exports = pool;
module.exports.buildOptions = buildOptions;
module.exports.createMigrationPool = createMigrationPool;
