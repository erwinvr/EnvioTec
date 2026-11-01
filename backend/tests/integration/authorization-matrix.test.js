// Authorization matrix (A12) against the real database: for every protected
// route, no session -> 401, session without the permission -> 403, session
// with the permission -> success. Also covers every reason a session stops
// being valid. Fixtures are created with the owner user and removed at the end.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import { generateSessionToken, hashToken, SESSION_COOKIE } from '../../src/core/auth/session-token.js';
import { loadConfig } from '../../src/core/config/index.js';
import { createPool } from '../../src/core/db/pool.js';
import { createRedisClient } from '../../src/core/redis/client.js';
import { deriveCsrfToken } from '../../src/core/security/csrf.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const PREFIX = `matrix_${randomBytes(4).toString('hex')}`;

// One entry per protected route. A new protected route without an entry here
// makes the matrix fail, so no route escapes it.
const MATRIX_CASES = {
  'GET /api/v1/permissions': { url: () => '/api/v1/permissions', success: 200 },
  'POST /api/v1/users/:id/mfa/reset': { url: (f) => `/api/v1/users/${f.targetId}/mfa/reset`, success: 200 },
  'GET /api/v1/audit-logs': { url: () => '/api/v1/audit-logs?pageSize=5', success: 200 },
  'GET /api/v1/audit-logs/export': { url: () => `/api/v1/audit-logs/export?${exportRange()}`, success: 200 },
};

function exportRange() {
  const day = 24 * 60 * 60 * 1000;
  return new URLSearchParams({
    from: new Date(Date.now() - day).toISOString(), to: new Date(Date.now() + day).toISOString(),
  }).toString();
}

describe('matriz de autorización', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let app;
  let pool;
  let redis;
  let owner;
  let config;
  const tokens = {};

  // Users with every route permission hold administrative ones, so they need
  // MFA: the fixture marks it as configured and the session as verified.
  async function createUser(name, {
    roleId, status = 'active', deleted = false, lockedMinutes = 0, expiresInMinutes = 43200, mfa = Boolean(roleId),
  } = {}) {
    const { rows } = await owner.query(
      `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, status, deleted_at,
                          locked_until, expires_at, mfa_secret_encrypted, mfa_enabled_at)
       VALUES ($1, $2, $8, 'local', '$argon2id$v=19$m=19456,t=2,p=1$x$y', $3, $4,
               CASE WHEN $5 THEN now() END,
               CASE WHEN $6 > 0 THEN now() + make_interval(mins => $6) END,
               now() + make_interval(mins => $7),
               CASE WHEN $9 THEN '\\x00'::bytea END, CASE WHEN $9 THEN now() END)
       RETURNING id`,
      [`${PREFIX}.${name}`, `${PREFIX}.${name}@example.test`, fixtures.areaId, status, deleted, lockedMinutes,
        expiresInMinutes, `Usuario ${name}`, mfa],
    );
    if (roleId) await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [rows[0].id, roleId]);
    return rows[0].id;
  }

  async function createSession(name, userId, { revoked = false, idleMinutes = 0 } = {}) {
    const token = generateSessionToken();
    await owner.query(
      `INSERT INTO sessions (id, user_id, expires_at, revoked_at, last_seen_at, mfa_verified_at, reauth_at)
       VALUES ($1, $2, now() + interval '8 hours', CASE WHEN $3 THEN now() END, now() - make_interval(mins => $4),
               now(), now())`,
      [hashToken(token), userId, revoked, idleMinutes],
    );
    tokens[name] = token;
  }

  const fixtures = {};

  before(async () => {
    owner = new pg.Client({ connectionString: readFileSync(process.env.MIGRATION_DATABASE_URL_FILE, 'utf8').trim() });
    await owner.connect();
    config = loadConfig(process.env);
    const logger = pino({ level: 'silent' });
    pool = createPool(config.database, logger, 'enviotec-tests');
    redis = createRedisClient(config.redis, logger);
    await redis.connect();
    app = await buildApp({ config, logger, db: pool, redis, checks: { database: async () => {} } });

    const { rows: area } = await owner.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [PREFIX]);
    fixtures.areaId = area[0].id;
    const { rows: role } = await owner.query('INSERT INTO roles (name) VALUES ($1) RETURNING id', [PREFIX]);
    fixtures.roleId = role[0].id;
    const routePermissions = app.routeInventory.filter((route) => !route.public).map((route) => route.permission);
    await owner.query(
      'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2::text[])',
      [fixtures.roleId, routePermissions],
    );

    fixtures.targetId = await createUser('target', { mfa: false });
    const allowed = await createUser('allowed', { roleId: fixtures.roleId });
    await createSession('allowed', allowed);
    await createSession('withoutPermission', await createUser('noperm'));
    await createSession('disabled', await createUser('disabled', { roleId: fixtures.roleId, status: 'disabled' }));
    await createSession('deleted', await createUser('deleted', { roleId: fixtures.roleId, deleted: true }));
    await createSession('locked', await createUser('locked', { roleId: fixtures.roleId, lockedMinutes: 10 }));
    await createSession('accountExpired', await createUser('expired', { roleId: fixtures.roleId, expiresInMinutes: -1 }));
    await createSession('revoked', allowed, { revoked: true });
    await createSession('idle', allowed, { idleMinutes: 31 });
    const expired = generateSessionToken();
    await owner.query(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, now() - interval '9 hours', now() - interval '1 minute', now() - interval '1 hour')`,
      [hashToken(expired), allowed],
    );
    tokens.absoluteExpired = expired;
  });

  after(async () => {
    await app?.close();
    await pool?.end();
    await redis?.quit();
    if (owner) {
      // Audited users cannot be deleted (audit_logs references them with ON
      // DELETE RESTRICT): fixtures are soft-deleted and lose their access.
      await owner.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'test_cleanup'
          WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE username LIKE $1)`,
        [`${PREFIX}.%`],
      );
      await owner.query('DELETE FROM user_roles WHERE role_id = $1', [fixtures.roleId]);
      await owner.query('DELETE FROM role_permissions WHERE role_id = $1', [fixtures.roleId]);
      await owner.query("UPDATE users SET deleted_at = now(), status = 'disabled' WHERE username LIKE $1", [`${PREFIX}.%`]);
      await owner.end();
    }
  });

  // State-changing requests carry what the browser would send: Origin and
  // the session's CSRF token.
  const request = (method, url, token) => {
    const headers = { origin: config.security.appOrigin };
    if (token) {
      headers.cookie = `${SESSION_COOKIE}=${token}`;
      headers['x-csrf-token'] = deriveCsrfToken(config.security.csrfSecret, hashToken(token));
    }
    return app.inject({ method, url, headers });
  };

  it('cada ruta protegida tiene su caso en la matriz', () => {
    const protectedRoutes = app.routeInventory.filter((route) => route.permission !== null && route.method !== 'HEAD');
    for (const route of protectedRoutes) {
      assert.ok(MATRIX_CASES[`${route.method} ${route.url}`], `falta el caso de matriz para ${route.method} ${route.url}`);
    }
  });

  for (const [route, testCase] of Object.entries(MATRIX_CASES)) {
    const [method] = route.split(' ');

    it(`${route}: sin sesión -> 401`, async () => {
      const res = await request(method, testCase.url(fixtures));
      assert.equal(res.statusCode, 401);
    });

    it(`${route}: sesión sin el permiso -> 403`, async () => {
      const res = await request(method, testCase.url(fixtures), tokens.withoutPermission);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN');
      const { rows } = await owner.query(
        `SELECT 1 FROM audit_logs WHERE action = 'authorization.deny' AND result = 'denied'
            AND resource_id = $1 AND actor_session_id = $2`,
        [route, hashToken(tokens.withoutPermission)],
      );
      assert.ok(rows.length > 0, 'todo 403 queda auditado (A7)');
    });

    it(`${route}: sesión con el permiso -> ${testCase.success}`, async () => {
      const res = await request(method, testCase.url(fixtures), tokens.allowed);
      assert.equal(res.statusCode, testCase.success);
    });
  }

  it('GET /api/v1/permissions devuelve el catálogo sincronizado', async () => {
    const res = await request('GET', '/api/v1/permissions', tokens.allowed);
    const body = res.json();
    assert.equal(body.meta.total, body.data.length);
    assert.ok(body.data.some((p) => p.code === 'roles.assign' && p.administrative === true));
    assert.deepEqual(Object.keys(body.data[0]).sort(), ['administrative', 'code', 'description']);
  });

  for (const state of ['revoked', 'idle', 'absoluteExpired', 'disabled', 'deleted', 'locked', 'accountExpired']) {
    it(`una sesión inválida (${state}) responde 401`, async () => {
      const res = await request('GET', '/api/v1/permissions', tokens[state]);
      assert.equal(res.statusCode, 401);
    });
  }

  it('toda ruta con sesión (permiso o authenticated) responde 401 sin sesión', async () => {
    const routes = app.routeInventory.filter((route) => !route.public && route.method !== 'HEAD');
    for (const route of routes) {
      const url = route.url.replace(':id', route.url.includes('sessions') ? 'a'.repeat(64) : fixtures.targetId);
      const res = await request(route.method, url);
      assert.equal(res.statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it('una sesión con MFA pendiente no usa sus permisos (AUTH_STEP_REQUIRED)', async () => {
    const pending = generateSessionToken();
    await owner.query('INSERT INTO sessions (id, user_id, expires_at) SELECT $1, id, now() + interval \'1 hour\' FROM users WHERE username = $2',
      [hashToken(pending), `${PREFIX}.allowed`]);
    const res = await request('GET', '/api/v1/permissions', pending);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'AUTH_STEP_REQUIRED');
    assert.deepEqual(res.json().error.details, [{ field: 'stage', code: 'mfa_verify' }]);
  });

  it('una sesión vencida por inactividad queda revocada y auditada', async () => {
    await request('GET', '/api/v1/permissions', tokens.idle);
    const { rows } = await owner.query(
      `SELECT s.revoked_reason, (SELECT count(*) FROM audit_logs a WHERE a.action = 'auth.session_expire' AND a.actor_session_id = s.id) AS audited
         FROM sessions s WHERE s.id = $1`,
      [hashToken(tokens.idle)],
    );
    assert.equal(rows[0].revoked_reason, 'expired');
    assert.equal(Number(rows[0].audited), 1);
  });

  it('un token desconocido con formato válido responde 401', async () => {
    const res = await request('GET', '/api/v1/permissions', generateSessionToken());
    assert.equal(res.statusCode, 401);
  });
});
