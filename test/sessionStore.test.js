'use strict';

process.env.NODE_ENV = 'test';

const { MySQLSessionStore } = require('../src/db/sessionStore');

const call = (store, method, ...args) =>
  new Promise((res, rej) => store[method](...args, (e, v) => (e ? rej(e) : res(v))));

function fakePool() {
  const rows = new Map();
  return {
    rows,
    query: jest.fn(async () => [[]]),
    execute: jest.fn(async (sql, p) => {
      if (sql.startsWith('SELECT')) return [rows.has(p[0]) ? [{ data: rows.get(p[0]) }] : []];
      if (sql.startsWith('INSERT')) { rows.set(p[0], p[1]); return [{}]; }
      if (sql.startsWith('DELETE FROM sessions WHERE sid')) { rows.delete(p[0]); return [{}]; }
      return [{ affectedRows: 0 }];
    }),
  };
}

const SESS = { cookie: { expires: new Date(Date.now() + 60000).toISOString() }, adminId: 1 };

test('creates the table, then stores, reads and destroys sessions', async () => {
  const pool = fakePool();
  const store = new MySQLSessionStore({ pool, cleanupIntervalMs: 0 });
  await call(store, 'set', 'abc', SESS);
  expect(pool.query.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS sessions/);
  const insert = pool.execute.mock.calls.find((c) => c[0].startsWith('INSERT'));
  expect(insert[1][2]).toBeInstanceOf(Date); // expires_at from the cookie
  expect(await call(store, 'get', 'abc')).toEqual(SESS);
  await call(store, 'destroy', 'abc');
  expect(await call(store, 'get', 'abc')).toBeNull();
});

test('falls back to memory (and logs once) when the table cannot be created', async () => {
  const pool = fakePool();
  pool.query.mockRejectedValue(new Error('CREATE command denied'));
  const logger = jest.fn();
  const store = new MySQLSessionStore({ pool, logger, cleanupIntervalMs: 0 });
  await call(store, 'set', 'x', SESS);
  expect(await call(store, 'get', 'x')).toMatchObject({ adminId: 1 });
  expect(pool.execute).not.toHaveBeenCalled();
  expect(logger).toHaveBeenCalledTimes(1);
  expect(logger.mock.calls[0][0]).toMatch(/in-memory/);
});

test('DB errors reach express-session as errors', async () => {
  const pool = fakePool();
  pool.execute.mockRejectedValue(new Error('gone away'));
  const store = new MySQLSessionStore({ pool, cleanupIntervalMs: 0 });
  await expect(call(store, 'get', 'abc')).rejects.toThrow('gone away');
});
