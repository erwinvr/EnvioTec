// Session lookup for every request. The only place in core/auth with SQL.

// Minimum time between two updates of last_seen_at for the same session, to
// avoid one write per request.
const TOUCH_INTERVAL_SECONDS = 60;

export function createSessionRepository(db) {
  return {
    // Returns the session and its user only if both are currently valid:
    // not revoked, within the idle and absolute timeouts, and the user active,
    // not deleted, not locked and (for local accounts) not expired.
    async findValidSession(tokenHash, idleTimeoutMinutes) {
      const { rows } = await db.query(
        `SELECT s.id AS session_id, s.created_at, s.last_seen_at, s.expires_at, s.mfa_verified_at, s.reauth_at,
                u.id AS user_id, u.username, u.display_name, u.auth_source, u.area_id, u.must_change_password,
                u.mfa_enabled_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
            AND s.last_seen_at > now() - make_interval(mins => $2)
            AND u.deleted_at IS NULL
            AND u.status = 'active'
            AND (u.locked_until IS NULL OR u.locked_until <= now())
            AND (u.auth_source = 'ad' OR u.exempt_from_expiry OR u.expires_at > now())`,
        [tokenHash, idleTimeoutMinutes],
      );
      return rows[0] ?? null;
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
  };
}
