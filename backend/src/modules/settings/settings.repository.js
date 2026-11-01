// SQL of the system parameters. app_runtime may update only value and
// updated_by (column grants, phase 2).

export function createSettingsRepository() {
  return {
    async list(db) {
      const { rows } = await db.query(
        `SELECT key, value_type, value, min_value, max_value, description, updated_at FROM system_settings ORDER BY key`,
      );
      return rows;
    },

    async findForUpdate(db, key) {
      const { rows } = await db.query(
        'SELECT key, value_type, value, min_value, max_value, description, updated_at FROM system_settings WHERE key = $1 FOR UPDATE',
        [key],
      );
      return rows[0] ?? null;
    },

    async update(db, key, value, actorId) {
      const { rows } = await db.query(
        `UPDATE system_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1
         RETURNING key, value_type, value, min_value, max_value, description, updated_at`,
        [key, JSON.stringify(value), actorId],
      );
      return rows[0];
    },
  };
}
