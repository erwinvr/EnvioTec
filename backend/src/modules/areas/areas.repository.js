// SQL of the areas module. `db` is the pool or a transaction client.

const COLUMNS = 'id, name, ad_department, is_active, created_at, updated_at';

export function createAreasRepository() {
  return {
    async list(db) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM areas ORDER BY name`);
      return rows;
    },

    async findById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM areas WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
      return rows[0] ?? null;
    },

    async create(db, { name, adDepartment, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO areas (name, ad_department, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING ${COLUMNS}`,
        [name, adDepartment ?? null, actorId],
      );
      return rows[0];
    },

    // Only the fields present in `changes` are updated (fixed column list).
    async update(db, id, changes, actorId) {
      const { rows } = await db.query(
        `UPDATE areas SET
            name = CASE WHEN $2 THEN $3 ELSE name END,
            ad_department = CASE WHEN $4 THEN $5 ELSE ad_department END,
            is_active = CASE WHEN $6 THEN $7 ELSE is_active END,
            updated_by = $8
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [id, 'name' in changes, changes.name ?? null, 'adDepartment' in changes, changes.adDepartment ?? null,
          'isActive' in changes, changes.isActive ?? null, actorId],
      );
      return rows[0] ?? null;
    },
  };
}
