// Phase 8.6: reports (ADR-025). The per-contact report looks recipients up
// by email across campaigns; the existing unique index starts with
// campaign_id and does not serve it.

export const up = (pgm) => {
  pgm.sql('CREATE INDEX campaign_recipients_email_idx ON campaign_recipients (email)');
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX campaign_recipients_email_idx');
};
