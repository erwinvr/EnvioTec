import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/core/auth/password.js';
import { hashToken, SESSION_COOKIE } from '../../src/core/auth/session-token.js';
import { hotp, timeStep } from '../../src/core/auth/totp.js';
import { loadConfig } from '../../src/core/config/index.js';
import { createPool } from '../../src/core/db/pool.js';
import { createRedisClient } from '../../src/core/redis/client.js';
import { deriveCsrfToken } from '../../src/core/security/csrf.js';

// Shared setup for integration tests that log in through the API, against
// the real PostgreSQL and Redis of the check environment.

export const PASSWORD = 'Caballo-Bateria-Grapa-77';

export function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const totpFor = (secretBase32, offset = 0) => hotp(base32Decode(secretBase32), timeStep() + offset);

// A different client IP per test keeps the per-IP login limit out of the way.
let ipCounter = 1;
export const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

export async function createHarness({ env = {}, mailer, adClientFactory } = {}) {
  const prefix = `t${randomBytes(4).toString('hex')}`;
  const config = loadConfig({ ...process.env, ...env });
  const logger = pino({ level: 'silent' });
  const owner = new pg.Client({ connectionString: readFileSync(process.env.MIGRATION_DATABASE_URL_FILE, 'utf8').trim() });
  await owner.connect();
  const pool = createPool(config.database, logger, 'enviotec-tests');
  const redis = createRedisClient(config.redis, logger);
  await redis.connect();
  const app = await buildApp({ config, logger, db: pool, redis, mailer, adClientFactory, checks: { database: async () => {} } });
  const passwordHash = await hashPassword(PASSWORD, config.argon2);
  const { rows: area } = await owner.query('INSERT INTO areas (name, ad_department) VALUES ($1, $2) RETURNING id', [prefix, `${prefix}-dep`]);
  const roles = {};
  const areaId = area[0].id;

  const harness = {
    prefix, config, owner, pool, redis, app, areaId, roles,

    async role(name, permissionCodes) {
      const { rows } = await owner.query('INSERT INTO roles (name) VALUES ($1) RETURNING id', [`${prefix}-${name}`]);
      await owner.query(
        'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2::text[])',
        [rows[0].id, permissionCodes],
      );
      roles[name] = rows[0].id;
      return rows[0].id;
    },

    // mfa: true marks MFA as configured (with a placeholder secret), for
    // users whose sessions are created directly with session().
    async localUser(name, {
      roles: roleIds = [], mustChangePassword = false, expiresInMinutes = 43200, mfa = false, area = areaId,
    } = {}) {
      const { rows } = await owner.query(
        `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, must_change_password,
                            expires_at, mfa_secret_encrypted, mfa_enabled_at)
         VALUES ($1, $2, $3, 'local', $4, $5, $6, now() + make_interval(mins => $7),
                 CASE WHEN $8 THEN '\\x00'::bytea END, CASE WHEN $8 THEN now() END) RETURNING id`,
        [`${prefix}.${name}`, `${prefix}.${name}@example.test`, `Usuario ${name}`, passwordHash, area,
          mustChangePassword, expiresInMinutes, mfa],
      );
      for (const roleId of roleIds) await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [rows[0].id, roleId]);
      return { id: rows[0].id, username: `${prefix}.${name}`, email: `${prefix}.${name}@example.test` };
    },

    async adUser(name, { guid, roles: roleIds = [] } = {}) {
      const { rows } = await owner.query(
        `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid, area_id)
         VALUES ($1, $2, $3, 'ad', $4, $5) RETURNING id`,
        [`${prefix}.${name}`, `${prefix}.${name}@example.test`, `Usuario ${name}`, guid ?? randomUUID(), areaId],
      );
      for (const roleId of roleIds) await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [rows[0].id, roleId]);
      return { id: rows[0].id, username: `${prefix}.${name}` };
    },

    // A session as if the user had just logged in with MFA (and reauthenticated).
    async session(userId, { reauth = true } = {}) {
      const token = randomBytes(32).toString('base64url');
      await owner.query(
        `INSERT INTO sessions (id, user_id, expires_at, mfa_verified_at, reauth_at)
         VALUES ($1, $2, now() + interval '8 hours', now(), CASE WHEN $3 THEN now() END)`,
        [hashToken(token), userId, reauth],
      );
      return token;
    },

    async area(name) {
      const { rows } = await owner.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [`${prefix}-${name}`]);
      return rows[0].id;
    },

    // Sends a request like the browser would: Origin always; cookie and CSRF
    // token when a session token is given.
    request(method, url, { token, payload, ip = '10.0.0.1', csrf = true, origin = config.security.appOrigin } = {}) {
      const headers = {};
      if (origin) headers.origin = origin;
      if (token) {
        headers.cookie = `${SESSION_COOKIE}=${token}`;
        if (csrf) headers['x-csrf-token'] = deriveCsrfToken(config.security.csrfSecret, hashToken(token));
      }
      return app.inject({ method, url, headers, payload, remoteAddress: ip });
    },

    async login(username, password = PASSWORD, options = {}) {
      const res = await harness.request('POST', '/api/v1/auth/login', { payload: { username, password }, ip: nextIp(), ...options });
      return { res, token: harness.tokenFrom(res) };
    },

    tokenFrom(res) {
      const cookie = [res.headers['set-cookie']].flat().find((value) => value?.startsWith(`${SESSION_COOKIE}=`));
      return cookie ? cookie.slice(SESSION_COOKIE.length + 1).split(';')[0] : null;
    },

    async audits(action, resourceId) {
      const { rows } = await owner.query(
        'SELECT result, metadata, actor_user_id FROM audit_logs WHERE action = $1 AND resource_id = $2 ORDER BY seq',
        [action, resourceId],
      );
      return rows;
    },

    async close() {
      await app.close();
      await pool.end();
      await redis.quit();
      // Audited users cannot be deleted (ON DELETE RESTRICT from audit_logs):
      // fixtures are soft-deleted and lose every session and role.
      await owner.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'test_cleanup'
          WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE username LIKE $1)`,
        [`${prefix}.%`],
      );
      await owner.query('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)', [`${prefix}.%`]);
      await owner.query("UPDATE users SET deleted_at = now(), status = 'disabled' WHERE username LIKE $1", [`${prefix}.%`]);
      await owner.end();
    },
  };
  return harness;
}
