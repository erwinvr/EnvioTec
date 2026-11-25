import { inJson, returning } from '../../../core/db/sql.js';

// SQL of the account jobs (Parte B, "Vigencia de cuentas locales"). users has
// a guard trigger: OUTPUT goes through a table variable.

const changed = () => returning({ id: 'uniqueidentifier', username: 'nvarchar(64)' });

export function createJobsRepository() {
  return {
    async disableExpired(db) {
      const out = changed();
      const { rows } = await db.query(
        `${out.declare}
         UPDATE users SET status = 'disabled', disabled_reason = 'expired', disabled_at = SYSUTCDATETIME(),
                updated_at = SYSUTCDATETIME()
         ${out.output}
          WHERE auth_source = 'local' AND status = 'active' AND deleted_at IS NULL
            AND exempt_from_expiry = 0 AND expires_at <= SYSUTCDATETIME();
         ${out.select}`,
      );
      return rows;
    },

    // Inactivity counts from the last login, the creation or the last
    // renewal/reactivation, whichever is latest. Accounts exempt from expiry
    // (the emergency account) are exempt from inactivity too: they exist for
    // the day nobody else can log in.
    async disableInactive(db, days) {
      const out = changed();
      const { rows } = await db.query(
        `${out.declare}
         UPDATE users SET status = 'disabled', disabled_reason = 'inactive', disabled_at = SYSUTCDATETIME(),
                updated_at = SYSUTCDATETIME()
         ${out.output}
          WHERE auth_source = 'local' AND status = 'active' AND deleted_at IS NULL AND exempt_from_expiry = 0
            AND GREATEST(last_login_at, created_at, activity_reset_at) < DATEADD(day, -$1, SYSUTCDATETIME());
         ${out.select}`,
        [days],
      );
      return rows;
    },

    // Marks and returns the accounts to warn, so each term is warned once.
    async claimExpiryWarnings(db, days) {
      const out = returning({
        id: 'uniqueidentifier', username: 'nvarchar(64)', email: 'varchar(254)', display_name: 'nvarchar(200)', expires_at: 'datetime2(3)',
      });
      const { rows } = await db.query(
        `${out.declare}
         UPDATE users SET expiry_warning_sent_at = SYSUTCDATETIME()
         ${out.output}
          WHERE auth_source = 'local' AND status = 'active' AND deleted_at IS NULL AND exempt_from_expiry = 0
            AND expiry_warning_sent_at IS NULL
            AND expires_at > SYSUTCDATETIME() AND expires_at <= DATEADD(day, $1, SYSUTCDATETIME());
         ${out.select}`,
        [days],
      );
      return rows;
    },

    async listActiveAdUsers(db, afterId, limit) {
      const { rows } = await db.query(
        `SELECT TOP ($2) id, username, ad_object_guid FROM users
          WHERE auth_source = 'ad' AND status = 'active' AND deleted_at IS NULL AND id > $1
          ORDER BY id`,
        [afterId, limit],
      );
      return rows;
    },

    async getSettings(db, keys) {
      const { rows } = await db.query(`SELECT [key], value FROM system_settings WHERE [key] IN ${inJson('$1')}`, [keys]);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}
