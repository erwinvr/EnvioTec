// Phase 8.3: Word templates (Parte B, ADR-004, ADR-012, ADR-013).
// A template belongs to an area and has numbered versions; each version is
// a .docx inspected in the file-processor and stored as sanitized HTML, a
// plain-text alternative, its variables and its inline images (cid).

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE templates (
      id          uuid PRIMARY KEY DEFAULT uuidv7(),
      area_id     uuid NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
      name        citext NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
      description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
      is_archived boolean NOT NULL DEFAULT false,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
      updated_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
      UNIQUE (area_id, name)
    );
    CREATE INDEX templates_created_by_idx ON templates (created_by);
    CREATE INDEX templates_updated_by_idx ON templates (updated_by);
    CREATE TRIGGER templates_updated_at BEFORE UPDATE ON templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE template_versions (
      id             uuid PRIMARY KEY DEFAULT uuidv7(),
      template_id    uuid NOT NULL REFERENCES templates (id) ON DELETE RESTRICT,
      version        integer NOT NULL CHECK (version > 0),
      status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
      file_id        uuid NOT NULL UNIQUE,
      original_name  text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
      size_bytes     integer NOT NULL CHECK (size_bytes > 0),
      sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      html           text,
      text_body      text,
      variables      text[] NOT NULL DEFAULT '{}',
      images         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(images) = 'array'),
      failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 100),
      created_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      created_at     timestamptz NOT NULL DEFAULT now(),
      processed_at   timestamptz,
      UNIQUE (template_id, version),
      CONSTRAINT template_versions_ready CHECK (status <> 'ready' OR (html IS NOT NULL AND text_body IS NOT NULL))
    );
    CREATE INDEX template_versions_created_by_idx ON template_versions (created_by);

    GRANT SELECT, INSERT, UPDATE ON templates, template_versions TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE template_versions, templates;');
};
