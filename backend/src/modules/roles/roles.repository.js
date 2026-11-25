import { existsBit, inJson, jsonStrings, returning } from '../../core/db/sql.js';

// SQL of the roles module. `db` is the pool or a transaction client. roles,
// role_permissions and user_roles have guard triggers (ADR-007): OUTPUT goes
// through a table variable there.

const summary = (lock = '') => `
  SELECT r.id, r.name, r.description, r.is_system, r.created_at, r.updated_at,
         (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
         (SELECT COUNT(*) FROM ad_group_role_mappings m WHERE m.role_id = r.id) AS mapping_count,
         ${existsBit(`SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
                       WHERE ur.role_id = r.id AND (u.auth_source = 'ad' OR ur.source = 'ad_group')
                      UNION ALL SELECT 1 FROM ad_group_role_mappings m WHERE m.role_id = r.id`)} AS used_from_ad,
         (SELECT ${jsonStrings('p.code')} FROM role_permissions rp
            JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id) AS permissions
    FROM roles r ${lock}`;

export function createRolesRepository() {
  return {
    async list(db) {
      const { rows } = await db.query(`${summary()} ORDER BY r.name`);
      return rows;
    },

    async findById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`${summary(forUpdate ? 'WITH (UPDLOCK, ROWLOCK)' : '')} WHERE r.id = $1`, [id]);
      return rows[0] ?? null;
    },

    async listMappings(db, roleId) {
      const { rows } = await db.query('SELECT id, group_dn FROM ad_group_role_mappings WHERE role_id = $1 ORDER BY group_dn', [roleId]);
      return rows;
    },

    async create(db, { name, description, actorId }) {
      const out = returning({ id: 'uniqueidentifier' });
      const { rows } = await db.query(
        `${out.declare} INSERT INTO roles (name, description, created_by, updated_by) ${out.output} VALUES ($1, $2, $3, $3); ${out.select}`,
        [name, description ?? '', actorId],
      );
      return rows[0].id;
    },

    async update(db, id, changes, actorId) {
      await db.query(
        `UPDATE roles SET name = CASE WHEN $2 = 1 THEN $3 ELSE name END,
                          description = CASE WHEN $4 = 1 THEN $5 ELSE description END,
                          updated_by = $6, updated_at = SYSUTCDATETIME()
          WHERE id = $1`,
        [id, 'name' in changes, changes.name ?? null, 'description' in changes, changes.description ?? null, actorId],
      );
    },

    async setPermissions(db, roleId, codes, actorId) {
      await db.query(
        `DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = $1 AND p.code NOT IN ${inJson('$2')}`,
        [roleId, codes],
      );
      await db.query(
        `INSERT INTO role_permissions (role_id, permission_id, granted_by)
         SELECT $1, p.id, $3 FROM permissions p
          WHERE p.code IN ${inJson('$2')}
            AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = $1 AND x.permission_id = p.id)`,
        [roleId, codes, actorId],
      );
    },

    async delete(db, id) {
      await db.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      await db.query('DELETE FROM roles WHERE id = $1', [id]);
    },

    async roleIdsOf(db, userId) {
      const { rows } = await db.query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId]);
      return new Set(rows.map((row) => row.role_id));
    },

    // A6 rule 6 and A5: users of a role whose permissions changed sign in again.
    async revokeSessionsOfRole(db, roleId) {
      const { rowCount } = await db.query(
        `UPDATE sessions SET revoked_at = SYSUTCDATETIME(), revoked_reason = 'role_permissions_changed'
          WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM user_roles WHERE role_id = $1)`,
        [roleId],
      );
      return rowCount;
    },
  };
}
