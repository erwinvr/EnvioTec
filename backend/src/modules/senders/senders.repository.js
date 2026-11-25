import { areaCondition } from '../../core/authorization/area-scope.js';

const COLUMNS = `s.id, s.area_id, a.name AS area_name, s.email, s.display_name, s.reply_to, s.is_active, s.created_at, s.updated_at`;

export function createSendersRepository() {
  return {
    async list(db, scope, { activeOnly }) {
      const params = [];
      const condition = areaCondition(scope, 's.area_id', params);
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM sender_identities s JOIN areas a ON a.id = s.area_id
          WHERE ${condition} ${activeOnly ? 'AND s.is_active = 1' : ''}
          ORDER BY a.name, s.email`,
        params,
      );
      return rows;
    },

    async findInScope(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const condition = areaCondition(scope, 's.area_id', params);
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM sender_identities s ${forUpdate ? 'WITH (UPDLOCK, ROWLOCK)' : ''} JOIN areas a ON a.id = s.area_id
          WHERE s.id = $1 AND ${condition}`,
        params,
      );
      return rows[0] ?? null;
    },

    async findArea(db, id) {
      const { rows } = await db.query('SELECT id, is_active FROM areas WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async domains(db) {
      const { rows } = await db.query(
        "SELECT [key], value FROM system_settings WHERE [key] IN ('sending.sender_domains', 'sending.reply_to_domains')",
      );
      const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      return { senderDomains: map['sending.sender_domains'] ?? [], replyToDomains: map['sending.reply_to_domains'] ?? [] };
    },

    async create(db, { areaId, email, displayName, replyTo, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO sender_identities (area_id, email, display_name, reply_to, created_by, updated_by)
         OUTPUT inserted.id VALUES ($1, $2, $3, $4, $5, $5)`,
        [areaId, email, displayName, replyTo ?? null, actorId],
      );
      return rows[0].id;
    },

    async update(db, id, changes, actorId) {
      await db.query(
        `UPDATE sender_identities SET
            display_name = CASE WHEN $2 = 1 THEN $3 ELSE display_name END,
            reply_to = CASE WHEN $4 = 1 THEN $5 ELSE reply_to END,
            is_active = CASE WHEN $6 = 1 THEN $7 ELSE is_active END,
            updated_by = $8, updated_at = SYSUTCDATETIME()
          WHERE id = $1`,
        [id, 'displayName' in changes, changes.displayName ?? null, 'replyTo' in changes, changes.replyTo ?? null,
          'isActive' in changes, changes.isActive ?? null, actorId],
      );
    },
  };
}
