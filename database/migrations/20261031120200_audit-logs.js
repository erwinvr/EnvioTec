// Audit log (A7, ADR-010): append-only, partitioned by month, with hash
// chaining columns. The audit service and the chain verification arrive in
// phase 4; the database-level protection exists from now on.

export const up = (pgm) => {
  pgm.sql(`
    -- Creates the monthly partitions of a table partitioned by a timestamptz
    -- range, from the current month (UTC) up to months_ahead months later.
    CREATE FUNCTION create_monthly_partitions(parent regclass, months_ahead integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DECLARE
      month_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
      created integer := 0;
      partition_name text;
      i integer;
    BEGIN
      IF months_ahead < 0 OR months_ahead > 24 THEN
        RAISE EXCEPTION 'months_ahead must be between 0 and 24';
      END IF;
      FOR i IN 0..months_ahead LOOP
        partition_name := format('%s_%s', parent::text, to_char(month_start + make_interval(months => i), 'YYYYMM'));
        IF to_regclass(partition_name) IS NULL THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
            partition_name, parent,
            (month_start + make_interval(months => i))::timestamp AT TIME ZONE 'UTC',
            (month_start + make_interval(months => i + 1))::timestamp AT TIME ZONE 'UTC'
          );
          created := created + 1;
        END IF;
      END LOOP;
      RETURN created;
    END;
    $$;
    REVOKE ALL ON FUNCTION create_monthly_partitions(regclass, integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION create_monthly_partitions(regclass, integer) TO app_runtime;

    CREATE TABLE audit_logs (
      seq              bigint GENERATED ALWAYS AS IDENTITY,
      id               uuid NOT NULL DEFAULT uuidv7(),
      occurred_at      timestamptz NOT NULL DEFAULT now(),
      actor_type       text NOT NULL CHECK (actor_type IN ('user', 'system', 'anonymous')),
      actor_user_id    uuid REFERENCES users (id) ON DELETE RESTRICT,
      actor_session_id bytea CHECK (actor_session_id IS NULL OR octet_length(actor_session_id) = 32),
      action           text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'),
      resource_type    text CHECK (length(resource_type) <= 50),
      resource_id      text CHECK (length(resource_id) <= 100),
      result           text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
      ip               inet,
      user_agent       text CHECK (length(user_agent) <= 512),
      request_id       text CHECK (length(request_id) <= 64),
      metadata         jsonb NOT NULL DEFAULT jsonb_build_object(),
      prev_hash        bytea CHECK (prev_hash IS NULL OR octet_length(prev_hash) = 32),
      hash             bytea NOT NULL CHECK (octet_length(hash) = 32),
      CONSTRAINT audit_logs_actor CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL)),
      PRIMARY KEY (seq, occurred_at),
      UNIQUE (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at);

    CREATE INDEX audit_logs_occurred_at_idx ON audit_logs (occurred_at);
    CREATE INDEX audit_logs_actor_user_id_idx ON audit_logs (actor_user_id, occurred_at);
    CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at);
    CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, occurred_at);
    CREATE INDEX audit_logs_result_idx ON audit_logs (result, occurred_at);

    -- Defense in depth (A7): even with an UPDATE or DELETE grant given by
    -- mistake, the rows cannot change.
    CREATE FUNCTION reject_audit_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
    END;
    $$;
    CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_audit_change();
    CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_change();

    SELECT create_monthly_partitions('audit_logs', 12);

    GRANT SELECT, INSERT ON audit_logs TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE audit_logs;
    DROP FUNCTION reject_audit_change(), create_monthly_partitions(regclass, integer);
  `);
};
