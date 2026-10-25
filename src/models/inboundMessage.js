'use strict';

/**
 * Inbound message model — every message a customer sends to our number.
 */

const pool = require('../db/pool');

const COLUMNS = `id, wamid, from_e164, contact_name, msg_type, text_body, media_id,
  context_wamid, opt_action, api_client_id, received_at, created_at`;

/**
 * Insert, deduping on wamid (Meta retries webhooks).
 * @returns {Promise<{id:number|null, duplicate:boolean}>}
 */
async function insert(m, db = pool) {
  try {
    const [r] = await db.execute(
      `INSERT INTO inbound_messages
         (wamid, from_e164, contact_name, msg_type, text_body, media_id,
          context_wamid, opt_action, api_client_id, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.wamid, m.fromE164, m.contactName || null, m.msgType, m.textBody || null,
        m.mediaId || null, m.contextWamid || null, m.optAction || null,
        m.apiClientId || null, JSON.stringify(m.payload || {}), m.receivedAt,
      ]
    );
    return { id: r.insertId, duplicate: false };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') return { id: null, duplicate: true };
    throw err;
  }
}

/** Latest message per contact for the inbox list. */
async function listConversations({ limit = 50 } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT i.from_e164, COALESCE(i.contact_name, c.name) AS contact_name, i.msg_type, i.text_body, i.received_at,
            c.opted_out_at,
            (i.received_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR) AS session_open,
            (SELECT COUNT(*) FROM inbound_messages x WHERE x.from_e164 = i.from_e164) AS total
       FROM inbound_messages i
       JOIN (SELECT from_e164, MAX(id) AS max_id FROM inbound_messages GROUP BY from_e164) last
         ON last.max_id = i.id
       LEFT JOIN contacts c ON c.e164 = i.from_e164
      ORDER BY i.received_at DESC, i.id DESC
      LIMIT ?`,
    [limit]
  );
  return rows;
}

/** Inbound + outbound messages for one number, oldest first. */
async function thread(e164, { limit = 100 } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT * FROM (
       SELECT 'in' AS dir, id, wamid, msg_type, text_body AS body, NULL AS status,
              NULL AS error_title, received_at AS at
         FROM inbound_messages WHERE from_e164 = ?
       UNION ALL
       SELECT 'out' AS dir, id, wamid, msg_type, body_preview AS body, status,
              error_title, created_at AS at
         FROM messages WHERE to_e164 = ?
     ) t
     ORDER BY at DESC, id DESC
     LIMIT ?`,
    [e164, e164, limit]
  );
  return rows.reverse();
}

/** Messages routed to a project, newest-after a cursor (API pull). */
async function listForClient(apiClientId, { sinceId = 0, limit = 50 } = {}, db = pool) {
  const [rows] = await db.query(
    `SELECT ${COLUMNS} FROM inbound_messages
      WHERE api_client_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
    [apiClientId, sinceId, limit]
  );
  return rows;
}

/** Count received in the last N days (dashboard). */
async function countSince(days = 30, db = pool) {
  const [rows] = await db.query(
    'SELECT COUNT(*) AS c FROM inbound_messages WHERE received_at >= UTC_TIMESTAMP() - INTERVAL ? DAY',
    [days]
  );
  return Number(rows[0] && rows[0].c) || 0;
}

module.exports = { insert, listConversations, thread, listForClient, countSince };
