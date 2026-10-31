// Server-side sessions and one-time tokens (A4, A5, ADR-002, ADR-006).
// Tokens and codes are stored only as SHA-256 hashes, never in clear text.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE sessions (
      id              bytea PRIMARY KEY CHECK (octet_length(id) = 32),
      user_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      created_at      timestamptz NOT NULL DEFAULT now(),
      last_seen_at    timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      ip              inet,
      user_agent      text CHECK (length(user_agent) <= 512),
      revoked_at      timestamptz,
      revoked_reason  text CHECK (length(revoked_reason) <= 100),
      mfa_verified_at timestamptz,
      reauth_at       timestamptz,
      CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
    );
    CREATE INDEX sessions_user_id_idx ON sessions (user_id) WHERE revoked_at IS NULL;
    CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

    CREATE TABLE password_reset_tokens (
      id         uuid PRIMARY KEY DEFAULT uuidv7(),
      token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at    timestamptz,
      CONSTRAINT password_reset_tokens_short_lived CHECK (expires_at <= created_at + interval '30 minutes')
    );
    CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

    CREATE TABLE mfa_recovery_codes (
      id         uuid PRIMARY KEY DEFAULT uuidv7(),
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      code_hash  bytea NOT NULL CHECK (octet_length(code_hash) = 32),
      created_at timestamptz NOT NULL DEFAULT now(),
      used_at    timestamptz,
      UNIQUE (user_id, code_hash)
    );

    CREATE TABLE mfa_enrollment_codes (
      id              uuid PRIMARY KEY DEFAULT uuidv7(),
      user_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      code_hash       bytea NOT NULL CHECK (octet_length(code_hash) = 32),
      issued_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      used_at         timestamptz,
      failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
      CONSTRAINT mfa_enrollment_codes_max_validity CHECK (expires_at <= created_at + interval '72 hours'),
      CONSTRAINT mfa_enrollment_codes_not_self_issued CHECK (issued_by <> user_id)
    );
    CREATE INDEX mfa_enrollment_codes_user_id_idx ON mfa_enrollment_codes (user_id);
    CREATE INDEX mfa_enrollment_codes_issued_by_idx ON mfa_enrollment_codes (issued_by);

    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, password_reset_tokens, mfa_recovery_codes, mfa_enrollment_codes
      TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE mfa_enrollment_codes, mfa_recovery_codes, password_reset_tokens, sessions;');
};
