// List variables and CSV column mapping (ADR-028).
// - contact_lists.attribute_labels: the label shown for each variable of the
//   list (name -> label). Existing attributes become variables labelled
//   after their name.
// - contact_imports: an import first waits for its column mapping
//   ("awaiting_mapping") with the CSV header and a small sample; the mapping
//   chosen by the user is kept with the import.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_lists ADD COLUMN attribute_labels jsonb NOT NULL DEFAULT '{}'
      CHECK (jsonb_typeof(attribute_labels) = 'object');
    UPDATE contact_lists
       SET attribute_labels = coalesce((SELECT jsonb_object_agg(name, initcap(replace(name, '_', ' '))) FROM unnest(attributes) AS name), '{}');

    ALTER TABLE contact_imports DROP CONSTRAINT contact_imports_status_check;
    ALTER TABLE contact_imports ADD CONSTRAINT contact_imports_status_check
      CHECK (status IN ('awaiting_mapping', 'pending', 'completed', 'failed'));
    ALTER TABLE contact_imports
      ADD COLUMN header  jsonb CHECK (header IS NULL OR jsonb_typeof(header) = 'array'),
      ADD COLUMN sample  jsonb CHECK (sample IS NULL OR jsonb_typeof(sample) = 'array'),
      ADD COLUMN mapping jsonb CHECK (mapping IS NULL OR jsonb_typeof(mapping) = 'array');
    CREATE INDEX contact_imports_awaiting_idx ON contact_imports (created_at) WHERE status = 'awaiting_mapping';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    UPDATE contact_imports SET status = 'failed', failure_reason = 'mapping_expired', finished_at = now() WHERE status = 'awaiting_mapping';
    DROP INDEX contact_imports_awaiting_idx;
    ALTER TABLE contact_imports DROP COLUMN header, DROP COLUMN sample, DROP COLUMN mapping;
    ALTER TABLE contact_imports DROP CONSTRAINT contact_imports_status_check;
    ALTER TABLE contact_imports ADD CONSTRAINT contact_imports_status_check CHECK (status IN ('pending', 'completed', 'failed'));
    ALTER TABLE contact_lists DROP COLUMN attribute_labels;
  `);
};
