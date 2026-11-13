'use strict';

/**
 * Delete everything stored about one phone number (data deletion requests).
 *
 * Runs in one transaction. Deletes messages, inbound messages, validation
 * results, the webhook events and project callbacks about those messages, and
 * the contact record. Bulk-job rows are anonymized rather than deleted so job
 * totals stay correct. If the number had opted out (STOP), a bare suppression
 * record (number + opt-out date) is kept so it is never messaged again.
 */

const pool = require('../db/pool');

/**
 * @param {string} e164 phone number in E.164 form, e.g. "+919820011234"
 * @returns {Promise<{ messages:number, inbound:number, validations:number,
 *   webhookEvents:number, callbacks:number, bulkItems:number,
 *   contact:'deleted'|'kept_opt_out'|'none' }>}
 */
async function deleteNumberData(e164, db = pool) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // wamids first, so webhook events about these messages can be found.
    const [outIds] = await conn.query('SELECT wamid FROM messages WHERE to_e164 = ? AND wamid IS NOT NULL', [e164]);
    const [inIds] = await conn.query('SELECT wamid FROM inbound_messages WHERE from_e164 = ?', [e164]);
    const wamids = [...outIds, ...inIds].map((r) => r.wamid);

    let webhookEvents = 0;
    if (wamids.length) {
      const [r] = await conn.query('DELETE FROM webhook_events WHERE wamid IN (?)', [wamids]);
      webhookEvents = r.affectedRows;
    }

    // Project callbacks whose JSON body mentions the number.
    const [cb] = await conn.query(
      'DELETE FROM callback_deliveries WHERE payload LIKE ?',
      [`%"${e164}"%`]
    );

    const [m] = await conn.query('DELETE FROM messages WHERE to_e164 = ?', [e164]);
    const [i] = await conn.query('DELETE FROM inbound_messages WHERE from_e164 = ?', [e164]);
    const [v] = await conn.query('DELETE FROM validation_results WHERE e164 = ?', [e164]);
    const [b] = await conn.query(
      `UPDATE bulk_job_items
          SET to_e164 = NULL, raw_input = '[deleted]', variables = NULL, wamid = NULL, error_detail = NULL
        WHERE to_e164 = ?`,
      [e164]
    );

    // Contact: keep only a suppression record if they opted out.
    const [[contact]] = await conn.query('SELECT opted_out_at FROM contacts WHERE e164 = ?', [e164]);
    let contactOutcome = 'none';
    if (contact && contact.opted_out_at) {
      await conn.query(
        'UPDATE contacts SET name = NULL, raw_input = NULL, country = NULL, last_inbound_at = NULL WHERE e164 = ?',
        [e164]
      );
      contactOutcome = 'kept_opt_out';
    } else if (contact) {
      await conn.query('DELETE FROM contacts WHERE e164 = ?', [e164]);
      contactOutcome = 'deleted';
    }

    await conn.commit();
    return {
      messages: m.affectedRows,
      inbound: i.affectedRows,
      validations: v.affectedRows,
      webhookEvents,
      callbacks: cb.affectedRows,
      bulkItems: b.affectedRows,
      contact: contactOutcome,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { deleteNumberData };
