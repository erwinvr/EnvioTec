// System parameters (Parte B, "Vigencia de cuentas locales"). The valid range
// of each numeric parameter is enforced by the database as well as by the
// backend; values are seeded in database/seeds/system/settings.js.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE system_settings (
      key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'),
      value_type  text NOT NULL CHECK (value_type IN ('integer', 'string_list', 'email_list')),
      value       jsonb NOT NULL,
      min_value   integer,
      max_value   integer,
      description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
      updated_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT system_settings_integer CHECK (
        value_type <> 'integer' OR (
          min_value IS NOT NULL AND max_value IS NOT NULL AND min_value <= max_value
          AND jsonb_typeof(value) = 'number'
          AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
          AND (value #>> '{}')::numeric BETWEEN min_value AND max_value
        )
      ),
      CONSTRAINT system_settings_list CHECK (
        value_type = 'integer' OR (jsonb_typeof(value) = 'array' AND min_value IS NULL AND max_value IS NULL)
      )
    );
    CREATE INDEX system_settings_updated_by_idx ON system_settings (updated_by);
    CREATE TRIGGER system_settings_updated_at BEFORE UPDATE ON system_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- The application only changes values; keys and ranges come from seeds.
    GRANT SELECT ON system_settings TO app_runtime;
    GRANT UPDATE (value, updated_by) ON system_settings TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE system_settings;');
};
