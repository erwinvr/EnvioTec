// SQL of the system parameters. app_runtime may update only value,
// updated_by and updated_at (column grants).

const COLUMNS = '[key], value_type, value, min_value, max_value, description, updated_at';

export function createSettingsRepository() {
  return {
    async list(db) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM system_settings ORDER BY [key]`);
      return rows;
    },

    async findForUpdate(db, key) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM system_settings WITH (UPDLOCK, ROWLOCK) WHERE [key] = $1`, [key]);
      return rows[0] ?? null;
    },

    async update(db, key, value, actorId) {
      const { rows } = await db.query(
        `UPDATE system_settings SET value = $2, updated_by = $3, updated_at = SYSUTCDATETIME()
         OUTPUT inserted.[key], inserted.value_type, inserted.value, inserted.min_value, inserted.max_value,
                inserted.description, inserted.updated_at
          WHERE [key] = $1`,
        [key, JSON.stringify(value), actorId],
      );
      return rows[0];
    },
  };
}
