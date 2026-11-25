// SQL of the areas module. `db` is the pool or a transaction client.

const COLUMNS = 'id, name, ad_department, is_active, created_at, updated_at';
const OUTPUT = COLUMNS.split(', ').map((column) => `inserted.${column}`).join(', ');

export function createAreasRepository() {
  return {
    async list(db) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM areas ORDER BY name`);
      return rows;
    },

    async findById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM areas ${forUpdate ? 'WITH (UPDLOCK, ROWLOCK)' : ''} WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },

    async create(db, { name, adDepartment, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO areas (name, ad_department, created_by, updated_by) OUTPUT ${OUTPUT} VALUES ($1, $2, $3, $3)`,
        [name, adDepartment ?? null, actorId],
      );
      return rows[0];
    },

    // Only the fields present in `changes` are updated (fixed column list).
    async update(db, id, changes, actorId) {
      const { rows } = await db.query(
        `UPDATE areas SET
            name = CASE WHEN $2 = 1 THEN $3 ELSE name END,
            ad_department = CASE WHEN $4 = 1 THEN $5 ELSE ad_department END,
            is_active = CASE WHEN $6 = 1 THEN $7 ELSE is_active END,
            updated_by = $8, updated_at = SYSUTCDATETIME()
          OUTPUT ${OUTPUT}
          WHERE id = $1`,
        [id, 'name' in changes, changes.name ?? null, 'adDepartment' in changes, changes.adDepartment ?? null,
          'isActive' in changes, changes.isActive ?? null, actorId],
      );
      return rows[0] ?? null;
    },
  };
}
