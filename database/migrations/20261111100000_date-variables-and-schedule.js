// Date variables and sending by each contact's date (ADR-030).
// - contact_lists.attribute_types: "text" or "date" per variable (missing
//   means text). Date values are stored as YYYY-MM-DD.
// - campaigns: schedule by a date variable of the list, with an offset in
//   days and a time of day (America/La_Paz); how many contacts were left
//   out at approval and why.
// - campaign_recipients.send_at: when each recipient is due.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_lists ADD COLUMN attribute_types jsonb NOT NULL DEFAULT '{}'
      CHECK (jsonb_typeof(attribute_types) = 'object');

    ALTER TABLE campaigns
      ADD COLUMN schedule_variable    text CHECK (schedule_variable IS NULL OR schedule_variable ~ '^[a-z][a-z0-9_]{0,39}$'),
      ADD COLUMN schedule_offset_days integer CHECK (schedule_offset_days BETWEEN -365 AND 365),
      ADD COLUMN schedule_time        time,
      ADD COLUMN excluded_no_date     integer CHECK (excluded_no_date >= 0),
      ADD COLUMN excluded_past        integer CHECK (excluded_past >= 0),
      ADD COLUMN excluded_too_far     integer CHECK (excluded_too_far >= 0),
      ADD CONSTRAINT campaigns_schedule_by_date CHECK (
        schedule_variable IS NULL OR (schedule_offset_days IS NOT NULL AND schedule_time IS NOT NULL)
      );

    ALTER TABLE campaign_recipients ADD COLUMN send_at timestamptz;
    CREATE INDEX campaign_recipients_due_idx ON campaign_recipients (campaign_id, send_at) WHERE status = 'pending' AND batch_id IS NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX campaign_recipients_due_idx;
    ALTER TABLE campaign_recipients DROP COLUMN send_at;
    ALTER TABLE campaigns DROP CONSTRAINT campaigns_schedule_by_date,
      DROP COLUMN schedule_variable, DROP COLUMN schedule_offset_days, DROP COLUMN schedule_time,
      DROP COLUMN excluded_no_date, DROP COLUMN excluded_past, DROP COLUMN excluded_too_far;
    ALTER TABLE contact_lists DROP COLUMN attribute_types;
  `);
};
