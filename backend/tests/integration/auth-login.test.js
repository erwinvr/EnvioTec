// Login, sessions, CSRF, enumeration, lockout and rate limiting (A5, A8,
// A12) against the real PostgreSQL and Redis.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashToken } from '../../src/core/auth/session-token.js';
import { createHarness, nextIp, PASSWORD } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe('login y sesiones', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let basic;

  before(async () => {
    // The per-account limit is raised here so the lockout can be tested on its
    // own; the limit itself is tested with the default values further down.
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_ACCOUNT: '50' } });
    const viewer = await h.role('viewer', ['campaigns.view']);
    basic = await h.localUser('basic', { roles: [viewer] });
  });
  after(() => h?.close());

  it('login correcto: cookie segura, etapa full, token CSRF y permisos, sin secretos en la respuesta', async () => {
    const { res, token } = await h.login(basic.username);
    assert.equal(res.statusCode, 200);
    const cookie = [res.headers['set-cookie']].flat()[0];
    assert.match(cookie, /^__Host-enviotec_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    const { data } = res.json();
    assert.equal(data.stage, 'full');
    assert.deepEqual(data.permissions, ['campaigns.view']);
    assert.equal(data.user.username, basic.username);
    assert.ok(data.csrfToken.length > 20);
    assert.ok(!/password|hash|secret/i.test(JSON.stringify(Object.keys(data.user))));
    assert.ok(!res.body.includes(token), 'el token solo viaja en la cookie');

    const { rows } = await h.owner.query('SELECT id FROM sessions WHERE user_id = $1', [basic.id]);
    assert.ok(rows.some((row) => row.id.equals(hashToken(token))), 'en la base solo está el hash del token');
    const audit = await h.audits('auth.login', basic.id);
    assert.equal(audit.at(-1).result, 'success');
  });

  it('cada login genera un token nuevo y revoca la sesión que traía la cookie (session fixation)', async () => {
    const first = await h.login(basic.username);
    const second = await h.request('POST', '/api/v1/auth/login', {
      token: first.token, csrf: false, ip: nextIp(), payload: { username: basic.username, password: PASSWORD },
    });
    const secondToken = h.tokenFrom(second);
    assert.notEqual(secondToken, first.token);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: first.token })).statusCode, 401);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: secondToken })).statusCode, 200);
  });

  it('usuario inexistente y contraseña incorrecta responden igual (sin enumeración)', async () => {
    const wrong = await h.login(basic.username, 'contraseña-incorrecta');
    const unknown = await h.login(`${h.prefix}.nadie`, 'contraseña-incorrecta');
    for (const res of [wrong.res, unknown.res]) {
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'INVALID_CREDENTIALS');
      assert.equal(res.headers['set-cookie'], undefined);
    }
    assert.equal(wrong.res.json().error.message, unknown.res.json().error.message);
  });

  it('los tiempos de respuesta son similares exista o no la cuenta (hash ficticio)', async () => {
    const time = async (username) => {
      const start = process.hrtime.bigint();
      await h.login(username, 'contraseña-incorrecta');
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const other = await h.localUser('timing');
    const existing = [];
    const missing = [];
    for (let i = 0; i < 3; i += 1) {
      existing.push(await time(other.username));
      missing.push(await time(`${h.prefix}.fantasma${i}`));
    }
    const median = (values) => values.sort((a, b) => a - b)[1];
    const ratio = median(existing) / median(missing);
    assert.ok(ratio > 0.5 && ratio < 2, `relación de tiempos ${ratio.toFixed(2)}`);
  });

  it('bloqueo progresivo: a los 5 fallos la cuenta se bloquea, aunque luego llegue la contraseña correcta', async () => {
    const user = await h.localUser('lockme');
    for (let i = 0; i < 5; i += 1) assert.equal((await h.login(user.username, 'mala-contraseña')).res.statusCode, 401);
    const { rows } = await h.owner.query('SELECT failed_login_count, locked_until > now() AS locked FROM users WHERE id = $1', [user.id]);
    assert.equal(rows[0].failed_login_count, 5);
    assert.equal(rows[0].locked, true);
    const correct = await h.login(user.username);
    assert.equal(correct.res.statusCode, 401);
    assert.equal(correct.res.json().error.code, 'INVALID_CREDENTIALS');
    const lockouts = await h.audits('auth.lockout', user.id);
    assert.equal(lockouts.length, 1);
    assert.equal(lockouts[0].metadata.minutes, 1);
    const denied = await h.audits('auth.login', user.id);
    assert.equal(denied.at(-1).metadata.reason, 'locked');
  });

  it('un login correcto reinicia el contador de fallos', async () => {
    const user = await h.localUser('reset-count');
    await h.login(user.username, 'mala-contraseña');
    await h.login(user.username);
    const { rows } = await h.owner.query('SELECT failed_login_count, last_login_at FROM users WHERE id = $1', [user.id]);
    assert.equal(rows[0].failed_login_count, 0);
    assert.ok(rows[0].last_login_at);
  });

  it('cuenta desactivada o vencida: mismo error genérico', async () => {
    const disabled = await h.localUser('disabled');
    await h.owner.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabled.id]);
    const expired = await h.localUser('expired', { expiresInMinutes: -1 });
    for (const user of [disabled, expired]) {
      const { res } = await h.login(user.username);
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'INVALID_CREDENTIALS');
    }
    assert.equal((await h.audits('auth.login', expired.id)).at(-1).metadata.reason, 'account_expired');
  });

  it('una cuenta de AD no entra si AD está deshabilitado (origen único)', async () => {
    const adUser = await h.adUser('solo-ad');
    const { res } = await h.login(adUser.username);
    assert.equal(res.statusCode, 401);
    assert.equal((await h.audits('auth.login', adUser.id)).at(-1).metadata.reason, 'ad_disabled');
  });

  it('CSRF: sin token o con Origin ajeno se rechaza; con ambos, el logout revoca la sesión', async () => {
    const { token } = await h.login(basic.username);
    const noToken = await h.request('POST', '/api/v1/auth/logout', { token, csrf: false });
    assert.equal(noToken.statusCode, 403);
    assert.equal(noToken.json().error.code, 'CSRF_REJECTED');
    const foreign = await h.request('POST', '/api/v1/auth/logout', { token, origin: 'https://atacante.test' });
    assert.equal(foreign.statusCode, 403);
    const ok = await h.request('POST', '/api/v1/auth/logout', { token });
    assert.equal(ok.statusCode, 200);
    assert.match([ok.headers['set-cookie']].flat()[0], /Max-Age=0/);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token })).statusCode, 401);
    const { rows } = await h.owner.query('SELECT revoked_reason FROM sessions WHERE id = $1', [hashToken(token)]);
    assert.equal(rows[0].revoked_reason, 'logout');
  });

  it('sesiones propias: listar, cerrar otra y no poder cerrar la de otro usuario (IDOR)', async () => {
    const a = await h.login(basic.username);
    const b = await h.login(basic.username);
    const list = await h.request('GET', '/api/v1/auth/sessions', { token: a.token });
    const sessions = list.json().data;
    assert.ok(sessions.some((s) => s.current && s.id === hashToken(a.token).toString('hex')));
    const otherId = hashToken(b.token).toString('hex');
    assert.equal((await h.request('DELETE', `/api/v1/auth/sessions/${otherId}`, { token: a.token })).statusCode, 200);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: b.token })).statusCode, 401);

    const stranger = await h.localUser('stranger');
    const s = await h.login(stranger.username);
    const res = await h.request('DELETE', `/api/v1/auth/sessions/${hashToken(a.token).toString('hex')}`, { token: s.token });
    assert.equal(res.statusCode, 404);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: a.token })).statusCode, 200);
  });

  it('re-autenticación: contraseña incorrecta 422, correcta registra reauth_at', async () => {
    const { token } = await h.login(basic.username);
    assert.equal((await h.request('POST', '/api/v1/auth/reauth', { token, payload: { password: 'mala' } })).statusCode, 422);
    assert.equal((await h.request('POST', '/api/v1/auth/reauth', { token, payload: { password: PASSWORD } })).statusCode, 200);
    const { rows } = await h.owner.query('SELECT reauth_at FROM sessions WHERE id = $1', [hashToken(token)]);
    assert.ok(rows[0].reauth_at);
  });
});

describe('rate limiting del login', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  before(async () => {
    h = await createHarness();
  });
  after(() => h?.close());

  it('por cuenta: el sexto intento en 15 minutos responde 429 con Retry-After', async () => {
    const username = `${h.prefix}.objetivo`;
    for (let i = 0; i < 5; i += 1) assert.equal((await h.login(username, 'x')).res.statusCode, 401);
    const { res } = await h.login(username, 'x');
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(res.headers['retry-after']) > 0);
  });

  it('por IP: al superar el límite responde 429 aunque cambie el usuario', async () => {
    const ip = '10.99.99.99';
    let last;
    for (let i = 0; i <= h.config.rateLimit.loginPerIp; i += 1) {
      last = await h.request('POST', '/api/v1/auth/login', { ip, payload: { username: `${h.prefix}.u${i}`, password: 'x' } });
    }
    assert.equal(last.statusCode, 429);
  });
});
