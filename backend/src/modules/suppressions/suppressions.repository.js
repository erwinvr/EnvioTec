import { createHash } from 'node:crypto';
import { escapeLike, page } from '../../core/db/sql.js';

// SQL of the global suppression list. The key is the SHA-256 of the
// lowercased email (UTF-8): computed here for the addresses that arrive as
// parameters, and by the database (email_hash columns) for stored contacts
// and recipients; both agree, and a CHECK keeps a stored address and its
// hash consistent.

export const emailHash = (email) => createHash('sha256').update(email.toLowerCase()).digest();

export function createSuppressionsRepository() {
  return {
    async list(db, { search, limit, offset }) {
      const params = [];
      let where = '';
      if (search) {
        // Exact match by hash also finds anonymized entries (no stored email).
        params.push(emailHash(search), `%${escapeLike(search)}%`);
        where = "WHERE s.email_hash = $1 OR s.email LIKE $2 ESCAPE '\\'";
      }
      const { rows: count } = await db.query(`SELECT COUNT(*) AS total FROM suppressions s ${where}`, params);
      params.push(offset, limit);
      const { rows } = await db.query(
        `SELECT s.id, s.email, LOWER(CONVERT(varchar(64), s.email_hash, 2)) AS email_hash, s.reason, s.source, s.note, s.created_at,
                u.username AS created_by_username
           FROM suppressions s LEFT JOIN users u ON u.id = s.created_by
          ${where}
          ORDER BY s.created_at DESC
          ${page(`$${params.length - 1}`, `$${params.length}`)}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    // Returns the new id, or null if the email was already suppressed. The
    // table has a guard trigger: OUTPUT goes through a table variable.
    async add(db, { email, reason, source, note = null, actorId = null }) {
      const { rows } = await db.query(
        `DECLARE @out TABLE (id uniqueidentifier);
         IF NOT EXISTS (SELECT 1 FROM suppressions WITH (UPDLOCK, HOLDLOCK) WHERE email_hash = $1)
           INSERT INTO suppressions (email_hash, email, reason, source, note, created_by)
           OUTPUT inserted.id INTO @out
           VALUES ($1, $2, $3, $4, $5, $6);
         SELECT id FROM @out;`,
        [emailHash(email), email.toLowerCase(), reason, source, note, actorId],
      );
      return rows[0]?.id ?? null;
    },

    async find(db, id) {
      const { rows } = await db.query('SELECT id, email, reason FROM suppressions WITH (UPDLOCK, ROWLOCK) WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async remove(db, id) {
      await db.query('DELETE FROM suppressions WHERE id = $1', [id]);
    },

    // Anonymization at the contact's request (Parte B): every copy of the
    // person in every area loses its personal data; events keep the contact
    // id (pseudonymous) and the email hash stays suppressed.
    async anonymize(db, email) {
      const pseudonym = "CONCAT('anon-', LOWER(CONVERT(varchar(36), id)), '@anonimizado.invalid')";
      const { rows } = await db.query(
        `UPDATE contacts SET email = ${pseudonym}, first_name = NULL, last_name = NULL,
                attributes = N'{}', anonymized_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
         OUTPUT inserted.id
          WHERE email = $1 AND anonymized_at IS NULL`,
        [email],
      );
      // Campaign snapshots too: the message id and the events stay under the
      // pseudonymous recipient id; nothing pending is sent.
      await db.query(
        `UPDATE campaign_recipients SET email = ${pseudonym}, first_name = NULL, last_name = NULL,
                attributes = N'{}', status = CASE WHEN status = 'pending' THEN 'suppressed' ELSE status END
          WHERE email = $1`,
        [email],
      );
      const hash = emailHash(email);
      await db.query(
        `IF EXISTS (SELECT 1 FROM suppressions WITH (UPDLOCK, HOLDLOCK) WHERE email_hash = $1)
           UPDATE suppressions SET email = NULL WHERE email_hash = $1;
         ELSE
           INSERT INTO suppressions (email_hash, email, reason, source) VALUES ($1, NULL, 'anonymized', 'anonymization');`,
        [hash],
      );
      return { contacts: rows.length, emailHash: hash.toString('hex') };
    },
  };
}
