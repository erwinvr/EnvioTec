// SQL of the authentication module. `db` is the pool or a transaction client.

const USER_COLUMNS = `
  u.id, u.username, u.email, u.display_name, u.auth_source, u.password_hash, u.ad_object_guid, u.area_id,
  u.status, u.must_change_password, u.failed_login_count, u.locked_until, u.mfa_secret_encrypted,
  u.mfa_enabled_at, u.mfa_last_used_step, u.expires_at, u.exempt_from_expiry, u.is_emergency, u.deleted_at,
  (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
  (u.auth_source = 'local' AND NOT u.exempt_from_expiry AND u.expires_at <= now()) AS is_expired`;

export function createAuthRepository() {
  return {
    async findUserByUsername(db, username) {
      const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.username = $1`, [username]);
      return rows[0] ?? null;
    },

    async findUserById(db, id, { forUpdate = false } = {}) {
      const { rows } = await db.query(
        `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
        [id],
      );
      return rows[0] ?? null;
    },

    async findUserByAdGuid(db, guid) {
      const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.ad_object_guid = $1`, [guid]);
      return rows[0] ?? null;
    },

    async findActiveLocalUserByEmail(db, email) {
      const { rows } = await db.query(
        `SELECT ${USER_COLUMNS} FROM users u
          WHERE u.email = $1 AND u.auth_source = 'local' AND u.status = 'active' AND u.deleted_at IS NULL
            AND (u.exempt_from_expiry OR u.expires_at > now())`,
        [email],
      );
      return rows[0] ?? null;
    },

    async emailOrUsernameTaken(db, { email, username, exceptId = null }) {
      const { rowCount } = await db.query(
        'SELECT 1 FROM users WHERE (email = $1 OR username = $2) AND ($3::uuid IS NULL OR id <> $3)',
        [email, username, exceptId],
      );
      return rowCount > 0;
    },

    // Counts a failed attempt atomically. The counter restarts when the last
    // failure is older than the reset window.
    async registerFailure(db, userId, resetWindowMinutes) {
      const { rows } = await db.query(
        `UPDATE users SET
            failed_login_count = CASE
              WHEN last_failed_login_at IS NULL OR last_failed_login_at < now() - make_interval(mins => $2) THEN 1
              ELSE failed_login_count + 1 END,
            last_failed_login_at = now()
          WHERE id = $1
          RETURNING failed_login_count`,
        [userId, resetWindowMinutes],
      );
      return rows[0].failed_login_count;
    },

    async lockUntil(db, userId, minutes) {
      const { rows } = await db.query(
        'UPDATE users SET locked_until = now() + make_interval(mins => $2) WHERE id = $1 RETURNING locked_until',
        [userId, minutes],
      );
      return rows[0].locked_until;
    },

    async registerSuccess(db, userId, { passwordHash = null } = {}) {
      await db.query(
        `UPDATE users SET failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL,
                last_login_at = now(), password_hash = coalesce($2, password_hash)
          WHERE id = $1`,
        [userId, passwordHash],
      );
    },

    async updatePassword(db, userId, passwordHash) {
      await db.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false,
                failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL, updated_by = $1
          WHERE id = $1`,
        [userId, passwordHash],
      );
    },

    async findAreaByDepartment(db, department) {
      if (!department) return null;
      const { rows } = await db.query(
        'SELECT id FROM areas WHERE ad_department = $1 AND is_active',
        [department],
      );
      return rows[0]?.id ?? null;
    },

    async listAdGroupMappings(db) {
      const { rows } = await db.query('SELECT group_dn, role_id FROM ad_group_role_mappings ORDER BY group_dn');
      return rows;
    },

    async createAdUser(db, entry, areaId) {
      const { rows } = await db.query(
        `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid, area_id, last_login_at)
         VALUES ($1, $2, $3, 'ad', $4, $5, now())
         RETURNING id`,
        [entry.username, entry.email, entry.displayName || entry.username, entry.objectGuid, areaId],
      );
      return rows[0].id;
    },

    // Refreshes the data AD owns. The area follows the department mapping;
    // without a match the user has no area (Parte B).
    async updateAdUser(db, userId, entry, areaId) {
      await db.query(
        `UPDATE users SET username = $2, email = $3, display_name = $4, area_id = $5
          WHERE id = $1 AND auth_source = 'ad'`,
        [userId, entry.username, entry.email, entry.displayName || entry.username, areaId],
      );
    },

    // Replaces the roles that come from AD groups; manual roles stay. Returns
    // whether anything changed.
    async syncAdRoles(db, userId, roleIds) {
      const removed = await db.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND source = 'ad_group' AND NOT (role_id = ANY($2::uuid[]))`,
        [userId, roleIds],
      );
      const added = await db.query(
        `INSERT INTO user_roles (user_id, role_id, source)
         SELECT $1, role_id, 'ad_group' FROM unnest($2::uuid[]) AS role_id
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, roleIds],
      );
      return removed.rowCount + added.rowCount > 0;
    },

    async createResetToken(db, { tokenHash, userId, ttlMinutes }) {
      await db.query(
        `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [tokenHash, userId, ttlMinutes],
      );
    },

    // Locks the token row so two concurrent resets cannot both use it.
    async findUsableResetToken(db, tokenHash) {
      const { rows } = await db.query(
        `SELECT user_id FROM password_reset_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tokenHash],
      );
      return rows[0]?.user_id ?? null;
    },

    async invalidateResetTokens(db, userId) {
      await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    },

    async getIntegerSetting(db, key) {
      const { rows } = await db.query('SELECT value FROM system_settings WHERE key = $1', [key]);
      return rows.length > 0 ? Number(rows[0].value) : null;
    },
  };
}
