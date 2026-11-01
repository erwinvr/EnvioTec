// Phase 8.5: sending through Mandrill and event synchronization (ADR-005,
// ADR-024).
// - send_batches: each batch moves pending -> in_flight -> accepted; a
//   timeout after sending makes it "ambiguous" until reconciled.
// - message_events: tracking events kept locally (Mandrill keeps them 30
//   days), partitioned by month, idempotent by a derived key.
// - quota_movements gains "refund": what Mandrill did not accept is given
//   back, so the balance only counts what was really sent.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quota_movements DROP CONSTRAINT quota_movements_kind_check;
    ALTER TABLE quota_movements ADD CONSTRAINT quota_movements_kind_check
      CHECK (kind IN ('adjust', 'reserve', 'release', 'consume', 'refund'));

    CREATE TABLE send_batches (
      id          uuid PRIMARY KEY DEFAULT uuidv7(),
      campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
      status      text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_flight', 'accepted', 'ambiguous', 'failed', 'cancelled')),
      size        integer NOT NULL CHECK (size > 0),
      attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      accepted    integer CHECK (accepted >= 0),
      rejected    integer CHECK (rejected >= 0),
      error       text CHECK (error IS NULL OR length(error) <= 200),
      queued_at   timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      sent_at     timestamptz
    );
    CREATE INDEX send_batches_campaign_idx ON send_batches (campaign_id, status);
    CREATE TRIGGER send_batches_updated_at BEFORE UPDATE ON send_batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    ALTER TABLE campaign_recipients
      ADD CONSTRAINT campaign_recipients_batch_fkey FOREIGN KEY (batch_id) REFERENCES send_batches (id) ON DELETE RESTRICT;
    CREATE INDEX campaign_recipients_batch_idx ON campaign_recipients (batch_id);

    CREATE TABLE message_events (
      id              uuid NOT NULL DEFAULT uuidv7(),
      campaign_id     uuid NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
      recipient_id    uuid REFERENCES campaign_recipients (id) ON DELETE RESTRICT,
      message_id      text NOT NULL CHECK (length(message_id) <= 100),
      event_type      text NOT NULL CHECK (event_type IN ('sent', 'open', 'click', 'hard_bounce', 'soft_bounce', 'spam', 'unsubscribe', 'reject', 'deferral')),
      occurred_at     timestamptz NOT NULL,
      url             text CHECK (url IS NULL OR length(url) <= 2000),
      idempotency_key bytea NOT NULL CHECK (octet_length(idempotency_key) = 32),
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, occurred_at),
      UNIQUE (idempotency_key, occurred_at)
    ) PARTITION BY RANGE (occurred_at);
    CREATE INDEX message_events_campaign_idx ON message_events (campaign_id, event_type, occurred_at);
    CREATE INDEX message_events_recipient_idx ON message_events (recipient_id, occurred_at);
    SELECT create_monthly_partitions('message_events', 12);
    -- Mandrill keeps events for 30 days: the previous month must exist too.
    DO $$
    DECLARE
      previous date := (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date;
    BEGIN
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF message_events FOR VALUES FROM (%L) TO (%L)',
        'message_events_' || to_char(previous, 'YYYYMM'),
        previous::timestamp AT TIME ZONE 'UTC', (previous + interval '1 month')::timestamp AT TIME ZONE 'UTC');
    END;
    $$;

    CREATE TABLE sync_state (
      key        text PRIMARY KEY CHECK (length(key) <= 100),
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    GRANT SELECT, INSERT, UPDATE ON send_batches, sync_state TO app_runtime;
    GRANT SELECT, INSERT ON message_events TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE sync_state, message_events;
    ALTER TABLE campaign_recipients DROP CONSTRAINT campaign_recipients_batch_fkey;
    DROP INDEX campaign_recipients_batch_idx;
    DROP TABLE send_batches;
    ALTER TABLE quota_movements DROP CONSTRAINT quota_movements_kind_check;
    ALTER TABLE quota_movements ADD CONSTRAINT quota_movements_kind_check CHECK (kind IN ('adjust', 'reserve', 'release', 'consume'));
  `);
};
