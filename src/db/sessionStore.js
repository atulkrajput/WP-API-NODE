'use strict';

/**
 * MySQL-backed express-session store.
 *
 * Replaces the default MemoryStore in production, which loses every login on
 * restart (Hostinger restarts idle apps) and breaks if more than one Node
 * process serves the app. Uses the app's existing mysql2 pool and creates its
 * own `sessions` table on first use, so no extra migration step is needed.
 *
 * If the table cannot be created (e.g. missing privileges), it logs once and
 * falls back to an in-memory store so the admin UI still works.
 */

const session = require('express-session');

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  sid        VARCHAR(128) NOT NULL PRIMARY KEY,
  data       MEDIUMTEXT   NOT NULL,
  expires_at DATETIME     NOT NULL,
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

class MySQLSessionStore extends session.Store {
  /**
   * @param {{ pool: object, ttlMs?: number, cleanupIntervalMs?: number, logger?: Function }} opts
   */
  constructor(opts) {
    super();
    this.pool = opts.pool;
    this.ttlMs = opts.ttlMs || 8 * 60 * 60 * 1000;
    this.log = opts.logger || (() => {});
    this.fallback = null;
    this.ready = this.pool.query(CREATE_SQL).then(
      () => true,
      (err) => {
        this.log(`Session table unavailable (${err.message}); using in-memory sessions.`);
        this.fallback = new session.MemoryStore();
        return false;
      }
    );
    const every = opts.cleanupIntervalMs === undefined ? 15 * 60 * 1000 : opts.cleanupIntervalMs;
    if (every > 0) {
      this.timer = setInterval(() => this.cleanup().catch(() => {}), every);
      this.timer.unref();
    }
  }

  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e) : new Date(Date.now() + this.ttlMs);
  }

  /** Run `fn` against MySQL, or `fb` against the fallback store. */
  run(cb, fn, fb) {
    this.ready
      .then((ok) => (ok ? fn() : fb(this.fallback)))
      .then((result) => cb && cb(null, result), (err) => cb && cb(err));
  }

  get(sid, cb) {
    this.run(cb, async () => {
      const [rows] = await this.pool.execute(
        'SELECT data FROM sessions WHERE sid = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1',
        [sid]
      );
      return rows.length ? JSON.parse(rows[0].data) : null;
    }, (m) => new Promise((res, rej) => m.get(sid, (e, s) => (e ? rej(e) : res(s)))));
  }

  set(sid, sess, cb) {
    this.run(cb, async () => {
      await this.pool.execute(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
        [sid, JSON.stringify(sess), this.expiry(sess)]
      );
    }, (m) => new Promise((res, rej) => m.set(sid, sess, (e) => (e ? rej(e) : res()))));
  }

  destroy(sid, cb) {
    this.run(cb, async () => {
      await this.pool.execute('DELETE FROM sessions WHERE sid = ?', [sid]);
    }, (m) => new Promise((res, rej) => m.destroy(sid, (e) => (e ? rej(e) : res()))));
  }

  touch(sid, sess, cb) {
    this.run(cb, async () => {
      await this.pool.execute('UPDATE sessions SET expires_at = ? WHERE sid = ?', [this.expiry(sess), sid]);
    }, (m) => new Promise((res, rej) => m.touch(sid, sess, (e) => (e ? rej(e) : res()))));
  }

  /** Delete expired rows. */
  async cleanup() {
    if (!(await this.ready)) return 0;
    const [r] = await this.pool.execute('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()');
    return r.affectedRows;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { MySQLSessionStore, CREATE_SQL };
