// Phase 8.2: contact lists, contacts, CSV imports and the global
// suppression list (Parte B, ADR-004, ADR-013).
// - Lists belong to an area and declare their own attributes
//   (^[a-z][a-z0-9_]{0,39}$, never email/first_name/last_name).
// - Contacts are unique per list by email (deduplication).
// - Suppressions are global (the whole organization) and keyed by the
//   SHA-256 of the lowercased email, so an anonymized contact stays
//   suppressed without keeping the address.

export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION list_attributes_valid(names text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT coalesce(bool_and(name ~ '^[a-z][a-z0-9_]{0,39}$' AND name NOT IN ('email', 'first_name', 'last_name')), true)
             AND cardinality(names) <= 30
             AND cardinality(names) = (SELECT count(DISTINCT n) FROM unnest(names) AS n)
        FROM unnest(names) AS name
    $$;

    CREATE TABLE contact_lists (
      id          uuid PRIMARY KEY DEFAULT uuidv7(),
      area_id     uuid NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
      name        citext NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
      description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
      attributes  text[] NOT NULL DEFAULT '{}' CHECK (list_attributes_valid(attributes)),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
      updated_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
      UNIQUE (area_id, name)
    );
    CREATE INDEX contact_lists_created_by_idx ON contact_lists (created_by);
    CREATE INDEX contact_lists_updated_by_idx ON contact_lists (updated_by);
    CREATE TRIGGER contact_lists_updated_at BEFORE UPDATE ON contact_lists FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE contacts (
      id            uuid PRIMARY KEY DEFAULT uuidv7(),
      area_id       uuid NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
      list_id       uuid NOT NULL REFERENCES contact_lists (id) ON DELETE RESTRICT,
      email         citext NOT NULL CHECK (length(email) <= 254 AND email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'),
      first_name    text CHECK (first_name IS NULL OR length(first_name) <= 100),
      last_name     text CHECK (last_name IS NULL OR length(last_name) <= 100),
      attributes    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
      anonymized_at timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
      UNIQUE (list_id, email),
      CONSTRAINT contacts_anonymized CHECK (
        anonymized_at IS NULL OR (first_name IS NULL AND last_name IS NULL AND attributes = '{}' AND email LIKE 'anon-%@anonimizado.invalid')
      )
    );
    CREATE INDEX contacts_area_id_idx ON contacts (area_id);
    CREATE INDEX contacts_email_idx ON contacts (email);
    CREATE INDEX contacts_created_by_idx ON contacts (created_by);
    CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE contact_imports (
      id             uuid PRIMARY KEY DEFAULT uuidv7(),
      area_id        uuid NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
      list_id        uuid NOT NULL REFERENCES contact_lists (id) ON DELETE RESTRICT,
      file_id        uuid NOT NULL UNIQUE,
      original_name  text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
      size_bytes     integer NOT NULL CHECK (size_bytes > 0),
      sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
      total_rows     integer CHECK (total_rows >= 0),
      inserted       integer CHECK (inserted >= 0),
      updated        integer CHECK (updated >= 0),
      rejected       integer CHECK (rejected >= 0),
      errors         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors) = 'array'),
      failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 100),
      created_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      created_at     timestamptz NOT NULL DEFAULT now(),
      finished_at    timestamptz
    );
    CREATE INDEX contact_imports_list_idx ON contact_imports (list_id, created_at DESC);
    CREATE INDEX contact_imports_area_id_idx ON contact_imports (area_id);
    CREATE INDEX contact_imports_created_by_idx ON contact_imports (created_by);

    CREATE TABLE suppressions (
      id         uuid PRIMARY KEY DEFAULT uuidv7(),
      email_hash bytea NOT NULL UNIQUE CHECK (octet_length(email_hash) = 32),
      email      citext CHECK (email IS NULL OR length(email) <= 254),
      reason     text NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'anonymized')),
      source     text NOT NULL CHECK (source IN ('mandrill', 'manual', 'anonymization')),
      note       text CHECK (note IS NULL OR length(note) <= 500),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT suppressions_anonymized_without_email CHECK (reason <> 'anonymized' OR email IS NULL)
    );
    CREATE INDEX suppressions_created_by_idx ON suppressions (created_by);

    -- Parte B: bounces, complaints, unsubscribes and anonymizations are
    -- excluded always, with no exception by role. Only manual entries can be
    -- removed, even if a DELETE grant is given by mistake.
    CREATE FUNCTION guard_suppressions() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND OLD.reason <> 'manual' THEN
        RAISE EXCEPTION 'only manual suppressions can be removed' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF TG_OP = 'UPDATE' AND (NEW.email_hash <> OLD.email_hash OR NEW.reason <> OLD.reason) THEN
        RAISE EXCEPTION 'a suppression cannot change its email or reason' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$;
    CREATE TRIGGER suppressions_guard BEFORE UPDATE OR DELETE ON suppressions
      FOR EACH ROW EXECUTE FUNCTION guard_suppressions();

    GRANT SELECT, INSERT, UPDATE ON contact_lists, contact_imports TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON suppressions TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE suppressions, contact_imports, contacts, contact_lists;
    DROP FUNCTION guard_suppressions(), list_attributes_valid(text[]);
  `);
};
