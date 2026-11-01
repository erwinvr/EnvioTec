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
        `SELECT r.id, r.name, EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                                       WHERE rp.role_id = r.id AND p.is_administrative) AS administrative
           FROM roles r WHERE r.id = $1`,
        [roleId],
      );
      return rows[0] ?? null;
    },

    async create(db, { groupDn, roleId, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO ad_group_role_mappings (group_dn, role_id, created_by, updated_by) VALUES ($1, $2, $3, $3)
         RETURNING id`,
        [groupDn, roleId, actorId],
      );
      return rows[0].id;
    },

    async delete(db, id) {
      const { rows } = await db.query('DELETE FROM ad_group_role_mappings WHERE id = $1 RETURNING group_dn, role_id', [id]);
      return rows[0] ?? null;
    },
  };
}
