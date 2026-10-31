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

const enabled = process.env.RUN_INTEGRATION === '1';
const PREFIX = `matrix_${randomBytes(4).toString('hex')}`;

// One entry per protected route. A new protected route without an entry here
// makes the matrix fail, so no route escapes it.
const MATRIX_CASES = {
  'GET /api/v1/permissions': { url: '/api/v1/permissions', success: 200 },
};

describe('matriz de autorización', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let app;
  let pool;
  let owner;
  const tokens = {};

  async function createUser(name, { roleId, status = 'active', deleted = false, lockedMinutes = 0, expiresInMinutes = 43200 } = {}) {
    const { rows } = await owner.query(
      `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, status, deleted_at,
                          locked_until, expires_at)
       VALUES ($1, $2, $8, 'local', '$argon2id$v=19$m=19456,t=2,p=1$x$y', $3, $4,
               CASE WHEN $5 THEN now() END,
               CASE WHEN $6 > 0 THEN now() + make_interval(mins => $6) END,
               now() + make_interval(mins => $7))
       RETURNING id`,
      [`${PREFIX}.${name}`, `${PREFIX}.${name}@example.test`, fixtures.areaId, status, deleted, lockedMinutes,
        expiresInMinutes, `Usuario ${name}`],
    );
    if (roleId) await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [rows[0].id, roleId]);
    return rows[0].id;
  }

  async function createSession(name, userId, { revoked = false, idleMinutes = 0 } = {}) {
    const token = generateSessionToken();
    await owner.query(
      `INSERT INTO sessions (id, user_id, expires_at, revoked_at, last_seen_at)
       VALUES ($1, $2, now() + interval '8 hours', CASE WHEN $3 THEN now() END, now() - make_interval(mins => $4))`,
      [hashToken(token), userId, revoked, idleMinutes],
    );
    tokens[name] = token;
  }

  const fixtures = {};

  before(async () => {
    owner = new pg.Client({ connectionString: readFileSync(process.env.MIGRATION_DATABASE_URL_FILE, 'utf8').trim() });
    await owner.connect();
    const config = loadConfig(process.env);
    const logger = pino({ level: 'silent' });
    pool = createPool(config.database, logger, 'enviotec-tests');
    app = await buildApp({ config, logger, db: pool, checks: { database: async () => {} } });

    const { rows: area } = await owner.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [PREFIX]);
    fixtures.areaId = area[0].id;
    const { rows: role } = await owner.query('INSERT INTO roles (name) VALUES ($1) RETURNING id', [PREFIX]);
    fixtures.roleId = role[0].id;
    const routePermissions = app.routeInventory.filter((route) => !route.public).map((route) => route.permission);
    await owner.query(
      'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2::text[])',
      [fixtures.roleId, routePermissions],
    );

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
    if (owner) {
      await owner.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)', [`${PREFIX}.%`]);
      await owner.query('DELETE FROM user_roles WHERE role_id = $1 OR user_id IN (SELECT id FROM users WHERE username LIKE $2)',
        [fixtures.roleId, `${PREFIX}.%`]);
      await owner.query('DELETE FROM role_permissions WHERE role_id = $1', [fixtures.roleId]);
      await owner.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}.%`]);
      await owner.query('DELETE FROM roles WHERE id = $1', [fixtures.roleId]);
      await owner.query('DELETE FROM areas WHERE id = $1', [fixtures.areaId]);
      await owner.end();
    }
  });

  const request = (method, url, token) => app.inject({
    method, url, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });

  it('cada ruta protegida tiene su caso en la matriz', () => {
    const protectedRoutes = app.routeInventory.filter((route) => !route.public && route.method !== 'HEAD');
    for (const route of protectedRoutes) {
      assert.ok(MATRIX_CASES[`${route.method} ${route.url}`], `falta el caso de matriz para ${route.method} ${route.url}`);
    }
  });

  for (const [route, testCase] of Object.entries(MATRIX_CASES)) {
    const [method] = route.split(' ');

    it(`${route}: sin sesión -> 401`, async () => {
      const res = await request(method, testCase.url);
      assert.equal(res.statusCode, 401);
    });

    it(`${route}: sesión sin el permiso -> 403`, async () => {
      const res = await request(method, testCase.url, tokens.withoutPermission);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN');
    });

    it(`${route}: sesión con el permiso -> ${testCase.success}`, async () => {
      const res = await request(method, testCase.url, tokens.allowed);
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

  it('un token desconocido con formato válido responde 401', async () => {
    const res = await request('GET', '/api/v1/permissions', generateSessionToken());
    assert.equal(res.statusCode, 401);
  });
});
