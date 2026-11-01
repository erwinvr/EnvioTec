// SQL of the account jobs (Parte B, "Vigencia de cuentas locales").

const RETURNING = 'RETURNING id, username';

export function createJobsRepository() {
  return {
    async disableExpired(db) {
      const { rows } = await db.query(
        `UPDATE users SET status = 'disabled', disabled_reason = 'expired', disabled_at = now()
          WHERE auth_source = 'local' AND status = 'active' AND deleted_at IS NULL
            AND NOT exempt_from_expiry AND expires_at <= now()
          ${RETURNING}`,
      );
      return rows;
    },

    // Inactivity counts from the last login, the creation or the last
    // renewal/reactivation, whichever is latest. Accounts exempt from expiry
    // (the emergency account) are exempt from inactivity too: they exist for
    // the day nobody else can log in.
    async disableInactive(db, days) {
      const { rows } = await db.query(
        `UPDATE users SET status = 'disabled', disabled_reason = 'inactive', disabled_at = now()
          WHERE auth_source = 'local' AND status = 'active' AND deleted_at IS NULL AND NOT exempt_from_expiry
            AND greatest(last_login_at, created_at, activity_reset_at) < now() - make_interval(days => $1)
          ${RETURNING}`,
        [days],
      );
      return rows;
    },

    // Marks and returns the accounts to warn, so each term is warned once.
    async claimExpiryWarnings(db, days) {
      const { rows } = await db.query(
        `UPDATE users SET expiry_warning_sent_at = now()
          WHERE auth_source = 'local' AND status = 'active' AND deleted_at IS NULL AND NOT exempt_from_expiry
            AND expiry_warning_sent_at IS NULL
            AND expires_at > now() AND expires_at <= now() + make_interval(days => $1)
          RETURNING id, username, email, display_name, expires_at`,
        [days],
      );
      return rows;
    },

    async listActiveAdUsers(db, afterId, limit) {
      const { rows } = await db.query(
        `SELECT id, username, ad_object_guid FROM users
          WHERE auth_source = 'ad' AND status = 'active' AND deleted_at IS NULL AND id > $1
          ORDER BY id LIMIT $2`,
        [afterId, limit],
      );
      return rows;
    },

    async getSettings(db, keys) {
      const { rows } = await db.query('SELECT key, value FROM system_settings WHERE key = ANY($1::text[])', [keys]);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}
