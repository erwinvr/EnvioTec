// Phase 3: authentication support (A5, A7, ADR-006, ADR-018).
// - Login throttling and TOTP replay protection columns.
// - Failed MFA attempts per session.
// - Audit chaining inside the database: append_audit_log() serializes the
//   inserts with an advisory lock, reads the previous hash and computes the new
//   one, so two concurrent inserts never share prev_hash (A7).

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN last_failed_login_at timestamptz,
      ADD COLUMN mfa_last_used_step bigint CHECK (mfa_last_used_step >= 0);

    ALTER TABLE sessions
      ADD COLUMN failed_mfa_count integer NOT NULL DEFAULT 0 CHECK (failed_mfa_count >= 0);

    -- Canonical form of an audit row for hashing. JSON encoding keeps the
    -- fields unambiguous; jsonb::text is deterministic (sorted keys). The
    -- chain verification script (phase 4) uses the same function.
    CREATE FUNCTION audit_log_canonical(
      p_id uuid, p_occurred_at timestamptz, p_actor_type text, p_actor_user_id uuid, p_actor_session_id bytea,
      p_action text, p_resource_type text, p_resource_id text, p_result text, p_ip inet, p_user_agent text,
      p_request_id text, p_metadata jsonb, p_prev_hash bytea
    ) RETURNS bytea
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT sha256(convert_to(jsonb_build_array(
        p_id::text,
        (extract(epoch FROM p_occurred_at) * 1000000)::bigint::text,
        p_actor_type, p_actor_user_id::text, encode(p_actor_session_id, 'hex'),
        p_action, p_resource_type, p_resource_id, p_result, p_ip::text, p_user_agent, p_request_id,
        p_metadata, encode(p_prev_hash, 'hex')
      )::text, 'UTF8'))
    $$;

    CREATE FUNCTION append_audit_log(
      p_actor_type text, p_actor_user_id uuid, p_actor_session_id bytea, p_action text,
      p_resource_type text, p_resource_id text, p_result text, p_ip inet, p_user_agent text,
      p_request_id text, p_metadata jsonb
    ) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DECLARE
      v_id uuid := uuidv7();
      v_occurred_at timestamptz;
      v_prev bytea;
    BEGIN
      -- Held until the end of the caller's transaction: the next insert waits
      -- and then reads this row as its predecessor.
      PERFORM pg_advisory_xact_lock(hashtext('enviotec.audit_logs'));
      v_occurred_at := date_trunc('microseconds', clock_timestamp());
      SELECT hash INTO v_prev FROM audit_logs ORDER BY seq DESC LIMIT 1;
      INSERT INTO audit_logs (id, occurred_at, actor_type, actor_user_id, actor_session_id, action, resource_type,
                              resource_id, result, ip, user_agent, request_id, metadata, prev_hash, hash)
      VALUES (v_id, v_occurred_at, p_actor_type, p_actor_user_id, p_actor_session_id, p_action, p_resource_type,
              p_resource_id, p_result, p_ip, p_user_agent, p_request_id, coalesce(p_metadata, '{}'::jsonb), v_prev,
              audit_log_canonical(v_id, v_occurred_at, p_actor_type, p_actor_user_id, p_actor_session_id, p_action,
                                  p_resource_type, p_resource_id, p_result, p_ip, p_user_agent, p_request_id,
                                  coalesce(p_metadata, '{}'::jsonb), v_prev));
      RETURN v_id;
    END;
    $$;
    REVOKE ALL ON FUNCTION append_audit_log(text, uuid, bytea, text, text, text, text, inet, text, text, jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION append_audit_log(text, uuid, bytea, text, text, text, text, inet, text, text, jsonb)
      TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION append_audit_log(text, uuid, bytea, text, text, text, text, inet, text, text, jsonb);
    DROP FUNCTION audit_log_canonical(uuid, timestamptz, text, uuid, bytea, text, text, text, text, inet, text, text,
                                      jsonb, bytea);
    ALTER TABLE sessions DROP COLUMN failed_mfa_count;
    ALTER TABLE users DROP COLUMN mfa_last_used_step, DROP COLUMN last_failed_login_at;
  `);
};
