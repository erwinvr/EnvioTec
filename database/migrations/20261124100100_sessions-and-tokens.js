import { NOW } from '../scripts/lib/sql-checks.js';

// Server-side sessions and one-time tokens (A4, A5, ADR-002, ADR-006).
// Tokens and codes are stored only as SHA-256 hashes, never in clear text.

export const up = `
CREATE TABLE sessions (
  id               varbinary(32) NOT NULL CONSTRAINT sessions_pkey PRIMARY KEY CHECK (DATALENGTH(id) = 32),
  user_id          uniqueidentifier NOT NULL CONSTRAINT sessions_user_id_fkey REFERENCES users (id),
  created_at       datetime2(3) NOT NULL DEFAULT ${NOW},
  last_seen_at     datetime2(3) NOT NULL DEFAULT ${NOW},
  expires_at       datetime2(3) NOT NULL,
  ip               varchar(45) NULL,
  user_agent       nvarchar(512) NULL,
  revoked_at       datetime2(3) NULL,
  revoked_reason   nvarchar(100) NULL,
  mfa_verified_at  datetime2(3) NULL,
  reauth_at        datetime2(3) NULL,
  failed_mfa_count int NOT NULL DEFAULT 0 CHECK (failed_mfa_count >= 0),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE password_reset_tokens (
  id         uniqueidentifier NOT NULL CONSTRAINT password_reset_tokens_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  token_hash varbinary(32) NOT NULL CONSTRAINT password_reset_tokens_token_hash_key UNIQUE CHECK (DATALENGTH(token_hash) = 32),
  user_id    uniqueidentifier NOT NULL CONSTRAINT password_reset_tokens_user_id_fkey REFERENCES users (id),
  created_at datetime2(3) NOT NULL DEFAULT ${NOW},
  expires_at datetime2(3) NOT NULL,
  used_at    datetime2(3) NULL,
  CONSTRAINT password_reset_tokens_short_lived CHECK (expires_at <= DATEADD(minute, 30, created_at))
);
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

CREATE TABLE mfa_recovery_codes (
  id         uniqueidentifier NOT NULL CONSTRAINT mfa_recovery_codes_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  user_id    uniqueidentifier NOT NULL CONSTRAINT mfa_recovery_codes_user_id_fkey REFERENCES users (id),
  code_hash  varbinary(32) NOT NULL CHECK (DATALENGTH(code_hash) = 32),
  created_at datetime2(3) NOT NULL DEFAULT ${NOW},
  used_at    datetime2(3) NULL,
  CONSTRAINT mfa_recovery_codes_user_id_code_hash_key UNIQUE (user_id, code_hash)
);

CREATE TABLE mfa_enrollment_codes (
  id              uniqueidentifier NOT NULL CONSTRAINT mfa_enrollment_codes_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  user_id         uniqueidentifier NOT NULL CONSTRAINT mfa_enrollment_codes_user_id_fkey REFERENCES users (id),
  code_hash       varbinary(32) NOT NULL CHECK (DATALENGTH(code_hash) = 32),
  issued_by       uniqueidentifier NOT NULL CONSTRAINT mfa_enrollment_codes_issued_by_fkey REFERENCES users (id),
  created_at      datetime2(3) NOT NULL DEFAULT ${NOW},
  expires_at      datetime2(3) NOT NULL,
  used_at         datetime2(3) NULL,
  failed_attempts int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  CONSTRAINT mfa_enrollment_codes_max_validity CHECK (expires_at <= DATEADD(hour, 72, created_at)),
  CONSTRAINT mfa_enrollment_codes_not_self_issued CHECK (issued_by <> user_id)
);
CREATE INDEX mfa_enrollment_codes_user_id_idx ON mfa_enrollment_codes (user_id);
CREATE INDEX mfa_enrollment_codes_issued_by_idx ON mfa_enrollment_codes (issued_by);

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_enrollment_codes TO app_runtime;
`;

export const down = 'DROP TABLE mfa_enrollment_codes, mfa_recovery_codes, password_reset_tokens, sessions;';
