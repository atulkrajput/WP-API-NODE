'use strict';

/**
 * Contact model — per-number state: 24h customer-service window and opt-out.
 */

const pool = require('../db/pool');

const SESSION_HOURS = 24;

/** Record an inbound message: create/refresh the contact and open the window. */
async function touchInbound(e164, { name = null, at }, db = pool) {
  await db.execute(
    `INSERT INTO contacts (e164, name, last_inbound_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = COALESCE(VALUES(name), name),
       last_inbound_at = GREATEST(COALESCE(last_inbound_at, VALUES(last_inbound_at)), VALUES(last_inbound_at))`,
    [e164, name ? String(name).slice(0, 120) : null, at]
  );
}

/** Set or clear opt-out. */
async function setOptOut(e164, optedOut, db = pool) {
  await db.execute(
    `INSERT INTO contacts (e164, opted_out_at) VALUES (?, ${optedOut ? 'UTC_TIMESTAMP()' : 'NULL'})
     ON DUPLICATE KEY UPDATE opted_out_at = ${optedOut ? 'COALESCE(opted_out_at, UTC_TIMESTAMP())' : 'NULL'}`,
    [e164]
  );
}

/**
 * Send-relevant state for a number.
 * @returns {Promise<{e164:string, name:string|null, optedOut:boolean, optedOutAt:string|null,
 *   lastInboundAt:string|null, sessionOpen:boolean, sessionExpiresAt:string|null}>}
 */
async function getState(e164, db = pool) {
  const [rows] = await db.execute(
    `SELECT e164, name, last_inbound_at, opted_out_at,
            (last_inbound_at IS NOT NULL AND last_inbound_at > UTC_TIMESTAMP() - INTERVAL ${SESSION_HOURS} HOUR) AS session_open,
            last_inbound_at + INTERVAL ${SESSION_HOURS} HOUR AS session_expires_at
       FROM contacts WHERE e164 = ? LIMIT 1`,
    [e164]
  );
  const r = rows[0];
  if (!r) {
    return { e164, name: null, optedOut: false, optedOutAt: null, lastInboundAt: null, sessionOpen: false, sessionExpiresAt: null };
  }
  const open = Boolean(Number(r.session_open));
  return {
    e164: r.e164,
    name: r.name,
    optedOut: Boolean(r.opted_out_at),
    optedOutAt: r.opted_out_at,
    lastInboundAt: r.last_inbound_at,
    sessionOpen: open,
    sessionExpiresAt: open ? r.session_expires_at : null,
  };
}

/** Is this number opted out? (bulk worker hot path) */
async function isOptedOut(e164, db = pool) {
  const [rows] = await db.execute(
    'SELECT 1 FROM contacts WHERE e164 = ? AND opted_out_at IS NOT NULL LIMIT 1',
    [e164]
  );
  return rows.length > 0;
}

module.exports = { touchInbound, setOptOut, getState, isOptedOut, SESSION_HOURS };
