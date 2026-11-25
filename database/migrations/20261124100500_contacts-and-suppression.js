import { BIN, EMAIL_TYPE, NOW, emailCheck, emailHash, isJson, sha256Hex } from '../scripts/lib/sql-checks.js';

// Contact lists, contacts, CSV imports and the global suppression list
// (Parte B, ADR-004, ADR-013, ADR-028, ADR-030).
// - Lists belong to an area and declare their variables: a JSON array of
//   technical names (^[a-z][a-z0-9_]{0,39}$, never email/first_name/
//   last_name), with a label and a type ("text" or "date") for each.
// - Contacts are unique per list by email (deduplication). email_hash is
//   the SHA-256 of the lowercased address, computed by the database, so the
//   suppression check is an indexed comparison.
// - Suppressions are global (the whole organization) and keyed by that
//   hash, so an anonymized contact stays suppressed without the address.
// - An import first waits for its column mapping ("awaiting_mapping") with
//   the CSV header and a small sample.

export const up = `
CREATE FUNCTION dbo.list_attributes_valid (@names nvarchar(max)) RETURNS bit
AS
BEGIN
  IF ISJSON(@names, ARRAY) = 0 RETURN 0;
  IF (SELECT COUNT(*) FROM OPENJSON(@names)) > 30 RETURN 0;
  IF EXISTS (
    SELECT 1 FROM OPENJSON(@names)
     WHERE type <> 1 OR LEN(value) NOT BETWEEN 1 AND 40 OR value ${BIN} NOT LIKE '[a-z]%'
        OR value ${BIN} LIKE '%[^a-z0-9_]%' OR value IN ('email', 'first_name', 'last_name')
  ) RETURN 0;
  IF (SELECT COUNT(DISTINCT value) FROM OPENJSON(@names)) <> (SELECT COUNT(*) FROM OPENJSON(@names)) RETURN 0;
  RETURN 1;
END
GO

CREATE TABLE contact_lists (
  id               uniqueidentifier NOT NULL CONSTRAINT contact_lists_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  area_id          uniqueidentifier NOT NULL CONSTRAINT contact_lists_area_id_fkey REFERENCES areas (id),
  name             nvarchar(100) NOT NULL CHECK (LEN(name) BETWEEN 2 AND 100),
  description      nvarchar(500) NOT NULL DEFAULT N'',
  attributes       nvarchar(max) NOT NULL DEFAULT N'[]' CHECK (dbo.list_attributes_valid(attributes) = 1),
  attribute_labels nvarchar(max) NOT NULL DEFAULT N'{}' CHECK (${isJson('attribute_labels', 'OBJECT')}),
  attribute_types  nvarchar(max) NOT NULL DEFAULT N'{}' CHECK (${isJson('attribute_types', 'OBJECT')}),
  created_at       datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at       datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by       uniqueidentifier NULL CONSTRAINT contact_lists_created_by_fkey REFERENCES users (id),
  updated_by       uniqueidentifier NULL CONSTRAINT contact_lists_updated_by_fkey REFERENCES users (id),
  CONSTRAINT contact_lists_area_id_name_key UNIQUE (area_id, name)
);
CREATE INDEX contact_lists_created_by_idx ON contact_lists (created_by);
CREATE INDEX contact_lists_updated_by_idx ON contact_lists (updated_by);

CREATE TABLE contacts (
  id            uniqueidentifier NOT NULL CONSTRAINT contacts_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  area_id       uniqueidentifier NOT NULL CONSTRAINT contacts_area_id_fkey REFERENCES areas (id),
  list_id       uniqueidentifier NOT NULL CONSTRAINT contacts_list_id_fkey REFERENCES contact_lists (id),
  email         ${EMAIL_TYPE} NOT NULL CHECK (${emailCheck('email')}),
  email_hash    AS ${emailHash('email')} PERSISTED,
  first_name    nvarchar(100) NULL,
  last_name     nvarchar(100) NULL,
  attributes    nvarchar(max) NOT NULL DEFAULT N'{}' CHECK (${isJson('attributes', 'OBJECT')}),
  anonymized_at datetime2(3) NULL,
  created_at    datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at    datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by    uniqueidentifier NULL CONSTRAINT contacts_created_by_fkey REFERENCES users (id),
  CONSTRAINT contacts_list_id_email_key UNIQUE (list_id, email),
  CONSTRAINT contacts_anonymized CHECK (
    anonymized_at IS NULL OR (first_name IS NULL AND last_name IS NULL AND attributes = N'{}' AND email LIKE 'anon-%@anonimizado.invalid')
  )
);
CREATE INDEX contacts_area_id_idx ON contacts (area_id);
CREATE INDEX contacts_email_idx ON contacts (email);
CREATE INDEX contacts_email_hash_idx ON contacts (email_hash);
CREATE INDEX contacts_created_by_idx ON contacts (created_by);

CREATE TABLE contact_imports (
  id             uniqueidentifier NOT NULL CONSTRAINT contact_imports_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  area_id        uniqueidentifier NOT NULL CONSTRAINT contact_imports_area_id_fkey REFERENCES areas (id),
  list_id        uniqueidentifier NOT NULL CONSTRAINT contact_imports_list_id_fkey REFERENCES contact_lists (id),
  file_id        uniqueidentifier NOT NULL CONSTRAINT contact_imports_file_id_key UNIQUE,
  original_name  nvarchar(255) NOT NULL CHECK (LEN(original_name) BETWEEN 1 AND 255),
  size_bytes     int NOT NULL CHECK (size_bytes > 0),
  sha256         varchar(64) NOT NULL CHECK (${sha256Hex('sha256')}),
  status         varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('awaiting_mapping', 'pending', 'completed', 'failed')),
  total_rows     int NULL CHECK (total_rows >= 0),
  inserted       int NULL CHECK (inserted >= 0),
  updated        int NULL CHECK (updated >= 0),
  rejected       int NULL CHECK (rejected >= 0),
  errors         nvarchar(max) NOT NULL DEFAULT N'[]' CHECK (${isJson('errors', 'ARRAY')}),
  header         nvarchar(max) NULL CHECK (header IS NULL OR ${isJson('header', 'ARRAY')}),
  sample         nvarchar(max) NULL CHECK (sample IS NULL OR ${isJson('sample', 'ARRAY')}),
  mapping        nvarchar(max) NULL CHECK (mapping IS NULL OR ${isJson('mapping', 'ARRAY')}),
  failure_reason nvarchar(100) NULL,
  created_by     uniqueidentifier NOT NULL CONSTRAINT contact_imports_created_by_fkey REFERENCES users (id),
  created_at     datetime2(3) NOT NULL DEFAULT ${NOW},
  finished_at    datetime2(3) NULL
);
CREATE INDEX contact_imports_list_idx ON contact_imports (list_id, created_at DESC);
CREATE INDEX contact_imports_area_id_idx ON contact_imports (area_id);
CREATE INDEX contact_imports_created_by_idx ON contact_imports (created_by);
CREATE INDEX contact_imports_awaiting_idx ON contact_imports (created_at) WHERE status = 'awaiting_mapping';

CREATE TABLE suppressions (
  id         uniqueidentifier NOT NULL CONSTRAINT suppressions_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  email_hash varbinary(32) NOT NULL CONSTRAINT suppressions_email_hash_key UNIQUE CHECK (DATALENGTH(email_hash) = 32),
  email      ${EMAIL_TYPE} NULL,
  reason     varchar(20) NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'anonymized')),
  source     varchar(20) NOT NULL CHECK (source IN ('mandrill', 'manual', 'anonymization')),
  note       nvarchar(500) NULL,
  created_at datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by uniqueidentifier NULL CONSTRAINT suppressions_created_by_fkey REFERENCES users (id),
  CONSTRAINT suppressions_anonymized_without_email CHECK (reason <> 'anonymized' OR email IS NULL),
  -- The hash is always the one of the address, when the address is kept.
  CONSTRAINT suppressions_hash_matches_email CHECK (email IS NULL OR email_hash = ${emailHash('email')})
);
CREATE INDEX suppressions_created_by_idx ON suppressions (created_by);
GO

-- Parte B: bounces, complaints, unsubscribes and anonymizations are
-- excluded always, with no exception by role. Only manual entries can be
-- removed, even if a DELETE grant is given by mistake.
CREATE TRIGGER suppressions_guard ON suppressions AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted WHERE reason <> 'manual')
    THROW 51001, 'only manual suppressions can be removed', 1;
  IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.id = i.id WHERE i.email_hash <> d.email_hash OR i.reason <> d.reason)
    THROW 51001, 'a suppression cannot change its email or reason', 1;
END
GO

GRANT SELECT, INSERT, UPDATE ON contact_lists TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON contact_imports TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON suppressions TO app_runtime;
GRANT EXECUTE ON dbo.list_attributes_valid TO app_runtime;
`;

export const down = `
DROP TABLE suppressions, contact_imports, contacts, contact_lists;
GO
DROP FUNCTION dbo.list_attributes_valid;
`;
