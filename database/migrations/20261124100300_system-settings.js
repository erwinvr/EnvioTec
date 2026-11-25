import { NOW, dottedCode } from '../scripts/lib/sql-checks.js';

// System parameters (Parte B, "Vigencia de cuentas locales"). The valid range
// of each numeric parameter is enforced by the database as well as by the
// backend; values are seeded in database/seeds/system/settings.js. The value
// is JSON: an integer or a list.

export const up = `
CREATE TABLE system_settings (
  [key]       varchar(100) NOT NULL CONSTRAINT system_settings_pkey PRIMARY KEY CHECK (${dottedCode('[key]')}),
  value_type  varchar(20) NOT NULL CHECK (value_type IN ('integer', 'string_list', 'email_list')),
  value       nvarchar(max) NOT NULL,
  min_value   int NULL,
  max_value   int NULL,
  description nvarchar(300) NOT NULL CHECK (LEN(description) BETWEEN 1 AND 300),
  updated_by  uniqueidentifier NULL CONSTRAINT system_settings_updated_by_fkey REFERENCES users (id),
  updated_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  CONSTRAINT system_settings_integer CHECK (
    value_type <> 'integer' OR (
      min_value IS NOT NULL AND max_value IS NOT NULL AND min_value <= max_value
      AND ISJSON(value, SCALAR) = 1 AND value NOT LIKE '%[^-0-9]%'
      AND TRY_CAST(value AS int) IS NOT NULL AND TRY_CAST(value AS int) BETWEEN min_value AND max_value
    )
  ),
  CONSTRAINT system_settings_list CHECK (
    value_type = 'integer' OR (ISJSON(value, ARRAY) = 1 AND min_value IS NULL AND max_value IS NULL)
  )
);
CREATE INDEX system_settings_updated_by_idx ON system_settings (updated_by);

-- The application only changes values; keys and ranges come from seeds.
GRANT SELECT ON system_settings TO app_runtime;
GRANT UPDATE (value, updated_by, updated_at) ON system_settings TO app_runtime;
`;

export const down = 'DROP TABLE system_settings;';
