// SQL of the global suppression list. The key is the SHA-256 of the
// lowercased email, computed in the database so every query agrees.

const HASH = "sha256(convert_to(lower($1::text), 'UTF8'))";

export function createSuppressionsRepository() {
  return {
    async list(db, { search, limit, offset }) {
      const params = [];
      let where = '';
      if (search) {
        params.push(search.toLowerCase());
        // Exact match by hash also finds anonymized entries (no stored email).
        where = `WHERE s.email_hash = ${HASH.replace('$1', `$${params.length}`)} OR s.email ILIKE '%' || $${params.length} || '%'`;
      }
      const { rows: count } = await db.query(`SELECT count(*)::int AS total FROM suppressions s ${where}`, params);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT s.id, s.email, encode(s.email_hash, 'hex') AS email_hash, s.reason, s.source, s.note, s.created_at,
                u.username AS created_by_username
           FROM suppressions s LEFT JOIN users u ON u.id = s.created_by
          ${where}
          ORDER BY s.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    // Returns the new id, or null if the email was already suppressed.
    async add(db, { email, reason, source, note = null, actorId = null }) {
      const { rows } = await db.query(
        `INSERT INTO suppressions (email_hash, email, reason, source, note, created_by)
         VALUES (${HASH}, $1, $2, $3, $4, $5)
         ON CONFLICT (email_hash) DO NOTHING RETURNING id`,
        [email.toLowerCase(), reason, source, note, actorId],
      );
      return rows[0]?.id ?? null;
    },

    async find(db, id) {
      const { rows } = await db.query('SELECT id, email, reason FROM suppressions WHERE id = $1 FOR UPDATE', [id]);
      return rows[0] ?? null;
    },

    async remove(db, id) {
      await db.query('DELETE FROM suppressions WHERE id = $1', [id]);
    },

    // Anonymization at the contact's request (Parte B): every copy of the
    // person in every area loses its personal data; events keep the contact
    // id (pseudonymous) and the email hash stays suppressed.
    async anonymize(db, email) {
      const { rows } = await db.query(
        `UPDATE contacts SET email = 'anon-' || id || '@anonimizado.invalid', first_name = NULL, last_name = NULL,
                attributes = '{}', anonymized_at = now()
          WHERE email = $1 AND anonymized_at IS NULL
          RETURNING id`,
        [email],
      );
      // Campaign snapshots too (8.4): the message id and the events stay
      // under the pseudonymous recipient id; nothing pending is sent.
      await db.query(
        `UPDATE campaign_recipients SET email = 'anon-' || id || '@anonimizado.invalid', first_name = NULL, last_name = NULL,
                attributes = '{}', status = CASE WHEN status = 'pending' THEN 'suppressed' ELSE status END
          WHERE email = $1`,
        [email],
      );
      const { rows: hash } = await db.query(
        `INSERT INTO suppressions (email_hash, email, reason, source)
         VALUES (${HASH}, NULL, 'anonymized', 'anonymization')
         ON CONFLICT (email_hash) DO UPDATE SET email = NULL
         RETURNING encode(email_hash, 'hex') AS email_hash`,
        [email.toLowerCase()],
      );
      return { contacts: rows.length, emailHash: hash[0].email_hash };
    },
  };
}
