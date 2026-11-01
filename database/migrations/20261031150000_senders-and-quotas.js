// Phase 8.1: allowed senders per area and send quotas (Parte B, ADR-011).
// - sender_identities: the only From/Reply-To a campaign may use; never
//   deleted, only deactivated, so campaigns keep pointing to them.
// - quotas: one row per user; reserved + consumed never exceed assigned.
// - quota_movements: append-only history (same protection as audit_logs).
// - monthly_send_usage: sends per calendar month (America/La_Paz), locked
//   by row to enforce the global cap.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE sender_identities (
      id            uuid PRIMARY KEY DEFAULT uuidv7(),
      area_id       uuid NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
      email         citext NOT NULL CHECK (length(email) <= 254 AND email ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'),
      display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100 AND display_name !~ '[\\r\\n<>"]'),
      reply_to      citext CHECK (reply_to IS NULL OR (length(reply_to) <= 254 AND reply_to ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')),
      is_active     boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
      updated_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
      UNIQUE (area_id, email)
    );
    CREATE INDEX sender_identities_area_id_idx ON sender_identities (area_id);
    CREATE INDEX sender_identities_created_by_idx ON sender_identities (created_by);
    CREATE INDEX sender_identities_updated_by_idx ON sender_identities (updated_by);
    CREATE TRIGGER sender_identities_updated_at BEFORE UPDATE ON sender_identities
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE quotas (
      user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
      assigned   integer NOT NULL DEFAULT 0 CHECK (assigned >= 0),
      reserved   integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
      consumed   integer NOT NULL DEFAULT 0 CHECK (consumed >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT quotas_within_assigned CHECK (reserved + consumed <= assigned)
    );
    CREATE TRIGGER quotas_updated_at BEFORE UPDATE ON quotas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE quota_movements (
      id             uuid PRIMARY KEY DEFAULT uuidv7(),
      user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      kind           text NOT NULL CHECK (kind IN ('adjust', 'reserve', 'release', 'consume')),
      amount         integer NOT NULL CHECK (amount <> 0 AND (kind = 'adjust' OR amount > 0)),
      assigned_after integer NOT NULL CHECK (assigned_after >= 0),
      reserved_after integer NOT NULL CHECK (reserved_after >= 0),
      consumed_after integer NOT NULL CHECK (consumed_after >= 0),
      campaign_id    uuid,
      reason         text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
      actor_user_id  uuid REFERENCES users (id) ON DELETE RESTRICT,
      occurred_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT quota_movements_adjust_reason CHECK (kind <> 'adjust' OR (reason IS NOT NULL AND actor_user_id IS NOT NULL))
    );
    CREATE INDEX quota_movements_user_idx ON quota_movements (user_id, occurred_at DESC);
    CREATE INDEX quota_movements_campaign_idx ON quota_movements (campaign_id) WHERE campaign_id IS NOT NULL;
    CREATE INDEX quota_movements_actor_idx ON quota_movements (actor_user_id);

    -- Same defense in depth as audit_logs: the history never changes.
    CREATE FUNCTION reject_append_only_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END;
    $$;
    CREATE TRIGGER quota_movements_no_update BEFORE UPDATE OR DELETE ON quota_movements
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TRIGGER quota_movements_no_truncate BEFORE TRUNCATE ON quota_movements
      FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

    CREATE TABLE monthly_send_usage (
      month      date PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
      sent       integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER monthly_send_usage_updated_at BEFORE UPDATE ON monthly_send_usage
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    GRANT SELECT, INSERT, UPDATE ON sender_identities, quotas, monthly_send_usage TO app_runtime;
    GRANT SELECT, INSERT ON quota_movements TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE monthly_send_usage, quota_movements, quotas, sender_identities;
    DROP FUNCTION reject_append_only_change();
  `);
};
