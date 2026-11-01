// Phase 5: user lifecycle (Parte B, "Vigencia de cuentas locales").
// - Why and when an account was disabled: a renewal reactivates accounts
//   disabled for expiry or inactivity, never one disabled by an administrator.
// - When the expiry notice was sent, so the daily job warns only once per term.
// - When the inactivity clock restarted (renewal or reactivation), so a renewed
//   account is not disabled again the next day for its old inactivity.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN disabled_reason text CHECK (disabled_reason IN ('manual', 'expired', 'inactive')),
      ADD COLUMN disabled_at timestamptz,
      ADD COLUMN expiry_warning_sent_at timestamptz,
      ADD COLUMN activity_reset_at timestamptz,
      ADD CONSTRAINT users_disabled_fields CHECK (
        (disabled_reason IS NULL) = (disabled_at IS NULL)
        AND (disabled_reason IS NULL OR status = 'disabled')
      );
    CREATE INDEX users_last_login_at_idx ON users (last_login_at) WHERE auth_source = 'local' AND deleted_at IS NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX users_last_login_at_idx;
    ALTER TABLE users DROP CONSTRAINT users_disabled_fields,
      DROP COLUMN activity_reset_at, DROP COLUMN expiry_warning_sent_at, DROP COLUMN disabled_at, DROP COLUMN disabled_reason;
  `);
};
