import { existsBit, returning } from '../../core/db/sql.js';

// SQL of the AD group to role mappings (ADR-007).

export function createDirectoryRepository() {
  return {
    async list(db) {
      const { rows } = await db.query(
        `SELECT m.id, m.group_dn, m.role_id, r.name AS role_name, m.created_at
           FROM ad_group_role_mappings m JOIN roles r ON r.id = m.role_id
          ORDER BY m.group_dn`,
      );
      return rows;
    },

    async findRole(db, roleId) {
      const { rows } = await db.query(
        `SELECT r.id, r.name, ${existsBit(`SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                                            WHERE rp.role_id = r.id AND p.is_administrative = 1`)} AS administrative
           FROM roles r WHERE r.id = $1`,
        [roleId],
      );
      return rows[0] ?? null;
    },

    // The table has a guard trigger: OUTPUT goes through a table variable.
    async create(db, { groupDn, roleId, actorId }) {
      const out = returning({ id: 'uniqueidentifier' });
      const { rows } = await db.query(
        `${out.declare}
         INSERT INTO ad_group_role_mappings (group_dn, role_id, created_by, updated_by) ${out.output} VALUES ($1, $2, $3, $3);
         ${out.select}`,
        [groupDn, roleId, actorId],
      );
      return rows[0].id;
    },

    async delete(db, id) {
      const out = returning({ group_dn: 'nvarchar(500)', role_id: 'uniqueidentifier' }, { source: 'deleted' });
      const { rows } = await db.query(`${out.declare} DELETE FROM ad_group_role_mappings ${out.output} WHERE id = $1; ${out.select}`, [id]);
      return rows[0] ?? null;
    },
  };
}
