import { areaCondition } from '../../core/authorization/area-scope.js';
import { escapeLike, inJson, jsonStrings, page, returning } from '../../core/db/sql.js';
import { lockName } from '../../core/db/transaction.js';

// SQL of the users module. Every read for a user (list, detail, target of
// an action) goes through the area scope (ADR-008). Sort columns come from an
// allowlist; every value is a bound parameter. users has a guard trigger:
// OUTPUT goes through a table variable.

export const SORT_COLUMNS = Object.freeze({
  username: 'u.username', displayName: 'u.display_name', createdAt: 'u.created_at',
  lastLoginAt: 'u.last_login_at', expiresAt: 'u.expires_at',
});

const SELECT_USER = `
  SELECT u.id, u.username, u.email, u.display_name, u.auth_source, u.area_id, a.name AS area_name, u.status,
         u.disabled_reason, u.must_change_password,
         CAST(CASE WHEN u.mfa_enabled_at IS NOT NULL THEN 1 ELSE 0 END AS bit) AS mfa_enabled,
         CASE WHEN u.locked_until > SYSUTCDATETIME() THEN u.locked_until END AS locked_until, u.expires_at,
         u.exempt_from_expiry, u.is_emergency, u.last_login_at, u.created_at,
         COALESCE((SELECT LOWER(CONVERT(nvarchar(36), r.id)) AS id, r.name, ur.source
                     FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id
                    ORDER BY r.name FOR JSON PATH), N'[]') AS roles
    FROM users u`;
const AREA_JOIN = 'LEFT JOIN areas a ON a.id = u.area_id';

function listWhere(scope, filters, params) {
  const conditions = ['u.deleted_at IS NULL', areaCondition(scope, 'u.area_id', params)];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (filters.search) {
    add("(u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')", `%${escapeLike(filters.search)}%`);
  }
  if (filters.status) add('u.status = ?', filters.status);
  if (filters.authSource) add('u.auth_source = ?', filters.authSource);
  if (filters.areaId) add('u.area_id = ?', filters.areaId);
  if (filters.roleId) add('EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_id = ?)', filters.roleId);
  return `WHERE ${conditions.join(' AND ')}`;
}

export function createUsersRepository() {
  return {
    async list(db, scope, filters, { sort, direction, limit, offset }) {
      const params = [];
      const where = listWhere(scope, filters, params);
      const { rows: count } = await db.query(`SELECT COUNT(*) AS total FROM users u ${where}`, params);
      const column = SORT_COLUMNS[sort];
      const order = `CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END, ${column} ${direction === 'desc' ? 'DESC' : 'ASC'}, u.id`;
      params.push(offset, limit);
      const { rows } = await db.query(
        `${SELECT_USER} ${AREA_JOIN} ${where} ORDER BY ${order} ${page(`$${params.length - 1}`, `$${params.length}`)}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    async findInScope(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const condition = areaCondition(scope, 'u.area_id', params);
      const { rows } = await db.query(
        `${SELECT_USER} ${forUpdate ? 'WITH (UPDLOCK, ROWLOCK)' : ''} ${AREA_JOIN}
          WHERE u.id = $1 AND u.deleted_at IS NULL AND ${condition}`,
        params,
      );
      return rows[0] ?? null;
    },

    async findArea(db, id) {
      const { rows } = await db.query('SELECT id, is_active FROM areas WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async createLocal(db, { username, email, displayName, areaId, passwordHash, expiresAt, actorId }) {
      const out = returning({ id: 'uniqueidentifier' });
      const { rows } = await db.query(
        `${out.declare}
         INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, must_change_password,
                            expires_at, created_by, updated_by)
         ${out.output}
         VALUES ($1, $2, $3, 'local', $4, $5, 1, $6, $7, $7);
         ${out.select}`,
        [username, email, displayName, passwordHash, areaId, expiresAt, actorId],
      );
      return rows[0].id;
    },

    async updateProfile(db, id, changes, actorId) {
      await db.query(
        `UPDATE users SET
            display_name = CASE WHEN $2 = 1 THEN $3 ELSE display_name END,
            email = CASE WHEN $4 = 1 THEN $5 ELSE email END,
            area_id = CASE WHEN $6 = 1 THEN $7 ELSE area_id END,
            updated_by = $8, updated_at = SYSUTCDATETIME()
          WHERE id = $1`,
        [id, 'displayName' in changes, changes.displayName ?? null, 'email' in changes, changes.email ?? null,
          'areaId' in changes, changes.areaId ?? null, actorId],
      );
    },

    async disable(db, id, reason, actorId) {
      await db.query(
        `UPDATE users SET status = 'disabled', disabled_reason = $2, disabled_at = SYSUTCDATETIME(), updated_by = $3, updated_at = SYSUTCDATETIME()
          WHERE id = $1`,
        [id, reason, actorId],
      );
    },

    async enable(db, id, actorId) {
      await db.query(
        `UPDATE users SET status = 'active', disabled_reason = NULL, disabled_at = NULL, activity_reset_at = SYSUTCDATETIME(),
                failed_login_count = 0, locked_until = NULL, updated_by = $2, updated_at = SYSUTCDATETIME()
          WHERE id = $1`,
        [id, actorId],
      );
    },

    async unlock(db, id, actorId) {
      await db.query(
        `UPDATE users SET failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL, updated_by = $2,
                updated_at = SYSUTCDATETIME()
          WHERE id = $1`,
        [id, actorId],
      );
    },

    async setTemporaryPassword(db, id, passwordHash, actorId) {
      await db.query(
        `UPDATE users SET password_hash = $2, must_change_password = 1, password_changed_at = SYSUTCDATETIME(),
                failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL, updated_by = $3,
                updated_at = SYSUTCDATETIME()
          WHERE id = $1 AND auth_source = 'local'`,
        [id, passwordHash, actorId],
      );
    },

    // Renewal: new expiry, warning cleared, inactivity clock restarted, and
    // reactivation when the account had been disabled by expiry or inactivity.
    async renew(db, id, expiresAt, actorId) {
      const out = returning({ status: 'varchar(10)' });
      const { rows } = await db.query(
        `${out.declare}
         UPDATE users SET expires_at = $2, expiry_warning_sent_at = NULL, activity_reset_at = SYSUTCDATETIME(),
                updated_by = $3, updated_at = SYSUTCDATETIME(),
                status = CASE WHEN disabled_reason IN ('expired', 'inactive') THEN 'active' ELSE status END,
                disabled_at = CASE WHEN disabled_reason IN ('expired', 'inactive') THEN NULL ELSE disabled_at END,
                disabled_reason = CASE WHEN disabled_reason IN ('expired', 'inactive') THEN NULL ELSE disabled_reason END
          ${out.output}
          WHERE id = $1;
         ${out.select}`,
        [id, expiresAt, actorId],
      );
      return rows[0].status;
    },

    // Roles with their permissions, to check what an assignment grants.
    async findRoles(db, roleIds) {
      const { rows } = await db.query(
        `SELECT r.id, r.name, r.is_system,
                (SELECT ${jsonStrings('p.code')} FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                  WHERE rp.role_id = r.id) AS permissions,
                CAST(CASE WHEN EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                                        WHERE rp.role_id = r.id AND p.is_administrative = 1) THEN 1 ELSE 0 END AS bit) AS administrative
           FROM roles r
          WHERE r.id IN ${inJson('$1')}`,
        [roleIds],
      );
      return rows;
    },

    async replaceManualRoles(db, userId, roleIds, actorId) {
      await db.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND source = 'manual' AND role_id NOT IN ${inJson('$2')}`,
        [userId, roleIds],
      );
      await db.query(
        `INSERT INTO user_roles (user_id, role_id, source, assigned_by)
         SELECT DISTINCT $1, CAST(j.value AS uniqueidentifier), 'manual', $3 FROM OPENJSON($2) j
          WHERE NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = $1 AND x.role_id = CAST(j.value AS uniqueidentifier))`,
        [userId, roleIds, actorId],
      );
    },

    // Active superadmins that are not the emergency account (which never
    // counts toward the minimum of one), optionally excluding one user.
    async countOtherActiveSuperadmins(db, exceptUserId) {
      await lockName(db, 'enviotec.superadmins');
      const { rows } = await db.query(
        `SELECT COUNT(*) AS n FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id AND r.name = 'superadmin' AND r.is_system = 1
          WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.is_emergency = 0 AND u.id <> $1`,
        [exceptUserId],
      );
      return rows[0].n;
    },

    // Each effective permission with the roles that grant it.
    async effectivePermissions(db, userId) {
      const { rows } = await db.query(
        `SELECT p.code, p.description, p.is_administrative,
                (SELECT ${jsonStrings('x.name')} FROM (
                   SELECT DISTINCT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     JOIN role_permissions rp ON rp.role_id = r.id
                    WHERE ur.user_id = $1 AND rp.permission_id = p.id) x) AS roles
           FROM permissions p
          WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                         WHERE ur.user_id = $1 AND rp.permission_id = p.id)
          ORDER BY p.code`,
        [userId],
      );
      return rows;
    },

    async getSettings(db, keys) {
      const { rows } = await db.query(`SELECT [key], value FROM system_settings WHERE [key] IN ${inJson('$1')}`, [keys]);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },

    async listLocalReview(db, scope, { limit, offset }) {
      const params = [];
      const condition = areaCondition(scope, 'u.area_id', params);
      const where = `WHERE u.auth_source = 'local' AND u.status = 'active' AND u.deleted_at IS NULL AND ${condition}`;
      const { rows: count } = await db.query(`SELECT COUNT(*) AS total FROM users u ${where}`, params);
      params.push(offset, limit);
      const { rows } = await db.query(
        `SELECT u.id, u.username, u.display_name, a.name AS area_name, u.last_login_at, u.expires_at,
                u.exempt_from_expiry, u.is_emergency,
                CAST(DATEDIFF_BIG(second, GREATEST(u.last_login_at, u.created_at, u.activity_reset_at), SYSUTCDATETIME()) / 86400 AS int)
                  AS inactive_days
           FROM users u LEFT JOIN areas a ON a.id = u.area_id
          ${where}
          ORDER BY CASE WHEN u.expires_at IS NULL THEN 1 ELSE 0 END, u.expires_at ASC, u.username
          ${page(`$${params.length - 1}`, `$${params.length}`)}`,
        params,
      );
      return { rows, total: count[0].total };
    },
  };
}
