import { NOW, isJson, sha256Hex } from '../scripts/lib/sql-checks.js';

// Word templates (Parte B, ADR-004, ADR-012, ADR-013). A template belongs to
// an area and has numbered versions; each version is a .docx inspected in the
// file-processor and stored as sanitized HTML, a plain-text alternative, its
// variables (JSON array) and its inline images (cid, JSON array).

export const up = `
CREATE TABLE templates (
  id          uniqueidentifier NOT NULL CONSTRAINT templates_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  area_id     uniqueidentifier NOT NULL CONSTRAINT templates_area_id_fkey REFERENCES areas (id),
  name        nvarchar(100) NOT NULL CHECK (LEN(name) BETWEEN 2 AND 100),
  description nvarchar(500) NOT NULL DEFAULT N'',
  is_archived bit NOT NULL DEFAULT 0,
  created_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by  uniqueidentifier NULL CONSTRAINT templates_created_by_fkey REFERENCES users (id),
  updated_by  uniqueidentifier NULL CONSTRAINT templates_updated_by_fkey REFERENCES users (id),
  CONSTRAINT templates_area_id_name_key UNIQUE (area_id, name)
);
CREATE INDEX templates_created_by_idx ON templates (created_by);
CREATE INDEX templates_updated_by_idx ON templates (updated_by);

CREATE TABLE template_versions (
  id             uniqueidentifier NOT NULL CONSTRAINT template_versions_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  template_id    uniqueidentifier NOT NULL CONSTRAINT template_versions_template_id_fkey REFERENCES templates (id),
  version        int NOT NULL CHECK (version > 0),
  status         varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  file_id        uniqueidentifier NOT NULL CONSTRAINT template_versions_file_id_key UNIQUE,
  original_name  nvarchar(255) NOT NULL CHECK (LEN(original_name) BETWEEN 1 AND 255),
  size_bytes     int NOT NULL CHECK (size_bytes > 0),
  sha256         varchar(64) NOT NULL CHECK (${sha256Hex('sha256')}),
  html           nvarchar(max) NULL,
  text_body      nvarchar(max) NULL,
  variables      nvarchar(max) NOT NULL DEFAULT N'[]' CHECK (${isJson('variables', 'ARRAY')}),
  images         nvarchar(max) NOT NULL DEFAULT N'[]' CHECK (${isJson('images', 'ARRAY')}),
  failure_reason nvarchar(100) NULL,
  created_by     uniqueidentifier NOT NULL CONSTRAINT template_versions_created_by_fkey REFERENCES users (id),
  created_at     datetime2(3) NOT NULL DEFAULT ${NOW},
  processed_at   datetime2(3) NULL,
  CONSTRAINT template_versions_template_id_version_key UNIQUE (template_id, version),
  CONSTRAINT template_versions_ready CHECK (status <> 'ready' OR (html IS NOT NULL AND text_body IS NOT NULL))
);
CREATE INDEX template_versions_created_by_idx ON template_versions (created_by);

GRANT SELECT, INSERT, UPDATE ON templates TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON template_versions TO app_runtime;
`;

export const down = 'DROP TABLE template_versions, templates;';
