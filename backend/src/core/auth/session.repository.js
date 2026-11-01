// Sessions (A5, ADR-002). The only place in core/auth with SQL. `db` may be
// the pool or a transaction client.

// Minimum time between two updates of last_seen_at for the same session, to
// avoid one write per request.
const TOUCH_INTERVAL_SECONDS = 60;

const VALID_SESSION = `
  s.revoked_at IS NULL
  AND s.expires_at > now()
  AND s.last_seen_at > now() - make_interval(mins => $2)`;

export function createSessionRepository(db) {
  return {
    // Returns the session and its user only if both are currently valid:
    // not revoked, within the idle and absolute timeouts, and the user active,
    // not deleted, not locked and (for local accounts) not expired.
    async findValidSession(tokenHash, idleTimeoutMinutes) {
      const { rows } = await db.query(
        `SELECT s.id AS session_id, s.created_at, s.last_seen_at, s.expires_at, s.mfa_verified_at, s.reauth_at,
                u.id AS user_id, u.username, u.email, u.display_name, u.auth_source, u.area_id,
                u.must_change_password, u.mfa_enabled_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND ${VALID_SESSION}
            AND u.deleted_at IS NULL
            AND u.status = 'active'
            AND (u.locked_until IS NULL OR u.locked_until <= now())
            AND (u.auth_source = 'ad' OR u.exempt_from_expiry OR u.expires_at > now())`,
        [tokenHash, idleTimeoutMinutes],
      );
      return rows[0] ?? null;
    },

    // Marks a session that timed out as revoked and returns its user, once,
    // so the expiration can be audited (A7). Returns null otherwise.
    async expireIfTimedOut(tokenHash, idleTimeoutMinutes) {
      const { rows } = await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'expired'
          WHERE id = $1 AND revoked_at IS NULL
            AND (expires_at <= now() OR last_seen_at <= now() - make_interval(mins => $2))
          RETURNING user_id`,
        [tokenHash, idleTimeoutMinutes],
      );
      return rows[0]?.user_id ?? null;
    },

    async touchSession(tokenHash) {
      await db.query(
        `UPDATE sessions SET last_seen_at = now()
          WHERE id = $1 AND last_seen_at < now() - make_interval(secs => $2)`,
        [tokenHash, TOUCH_INTERVAL_SECONDS],
      );
    },

    async findEffectivePermissions(userId) {
      const { rows } = await db.query(
        `SELECT DISTINCT p.code
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = $1`,
        [userId],
      );
      return new Set(rows.map((row) => row.code));
    },

    async create({ tokenHash, userId, absoluteTimeoutMinutes, ip, userAgent, mfaVerified = false, expiresAt = null }) {
      const { rows } = await db.query(
        `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent, mfa_verified_at, reauth_at)
         VALUES ($1, $2, coalesce($3::timestamptz, now() + make_interval(mins => $4)), $5, $6,
                 CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN now() END)
         RETURNING expires_at`,
        [tokenHash, userId, expiresAt, absoluteTimeoutMinutes, ip, userAgent?.slice(0, 512) ?? null, mfaVerified],
      );
      return rows[0];
    },

    // Replaces a session with a new token (A5: regenerate after MFA and after
    // privilege changes). Keeps the absolute expiry of the original login.
    async rotate(oldHash, newHash, { mfaVerified = false, reason = 'rotated' } = {}) {
      const { rows } = await db.query(
        `WITH old AS (
           UPDATE sessions SET revoked_at = now(), revoked_reason = $3
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING user_id, expires_at, ip, user_agent, mfa_verified_at, reauth_at
         )
         INSERT INTO sessions (id, user_id, expires_at, ip, user_agent, mfa_verified_at, reauth_at)
         SELECT $2, user_id, expires_at, ip, user_agent,
                CASE WHEN $4 THEN now() ELSE mfa_verified_at END,
                CASE WHEN $4 THEN now() ELSE reauth_at END
           FROM old
         RETURNING expires_at`,
        [oldHash, newHash, reason, mfaVerified],
      );
      return rows[0] ?? null;
    },

    async revoke(tokenHash, reason) {
      const { rowCount } = await db.query(
        'UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
        [tokenHash, reason],
      );
      return rowCount > 0;
    },

    async revokeOwn(userId, tokenHash, reason) {
      const { rowCount } = await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [tokenHash, userId, reason],
      );
      return rowCount > 0;
    },

    // Revokes every active session of a user except, optionally, one.
    async revokeAllForUser(userId, reason, { exceptHash = null } = {}) {
      const { rowCount } = await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
          WHERE user_id = $1 AND revoked_at IS NULL AND ($3::bytea IS NULL OR id <> $3)`,
        [userId, reason, exceptHash],
      );
      return rowCount;
    },

    async listActiveForUser(userId, idleTimeoutMinutes) {
      const { rows } = await db.query(
        `SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, host(s.ip) AS ip, s.user_agent
           FROM sessions s
          WHERE s.user_id = $1 AND ${VALID_SESSION}
          ORDER BY s.last_seen_at DESC
          LIMIT 100`,
        [userId, idleTimeoutMinutes],
      );
      return rows;
    },

    async markReauthenticated(tokenHash) {
      await db.query('UPDATE sessions SET reauth_at = now() WHERE id = $1 AND revoked_at IS NULL', [tokenHash]);
    },

    // Counts a failed MFA attempt in the session and returns the new total.
    async addFailedMfa(tokenHash) {
      const { rows } = await db.query(
        'UPDATE sessions SET failed_mfa_count = failed_mfa_count + 1 WHERE id = $1 RETURNING failed_mfa_count',
        [tokenHash],
      );
      return rows[0]?.failed_mfa_count ?? 0;
    },
  };
}
