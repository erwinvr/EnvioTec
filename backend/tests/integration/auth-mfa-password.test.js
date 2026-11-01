// MFA, password change, recovery by email and administrative MFA reset
// (A5, ADR-006) against the real PostgreSQL and Redis.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setImmediate } from 'node:timers';
import { hashToken } from '../../src/core/auth/session-token.js';
import { createHarness, PASSWORD, totpFor } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const NEW_PASSWORD = 'Lampara-Ventana-Rio-2049';

describe('MFA, contraseñas y recuperación', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  const mailer = { enabled: true, sent: [], async send(message) { this.sent.push(message); } };

  before(async () => {
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_ACCOUNT: '50' }, mailer });
    await h.role('admin', ['users.reset_mfa', 'permissions.view']);
    await h.role('viewer', ['campaigns.view']);
  });
  after(() => h?.close());

  async function enrolledAdmin(name) {
    const user = await h.localUser(name, { roles: [h.roles.admin] });
    const { token } = await h.login(user.username);
    const start = await h.request('POST', '/api/v1/auth/mfa/enroll/start', { token, payload: {} });
    const { secret } = start.json().data;
    const code = totpFor(secret);
    const confirm = await h.request('POST', '/api/v1/auth/mfa/enroll/confirm', { token, payload: { code } });
    return { user, secret, code, token: h.tokenFrom(confirm), confirm };
  }

  it('MFA obligatorio: el administrador sin MFA queda en mfa_enroll y no usa sus permisos', async () => {
    const user = await h.localUser('admin-pending', { roles: [h.roles.admin] });
    const { res, token } = await h.login(user.username);
    assert.equal(res.json().data.stage, 'mfa_enroll');
    assert.deepEqual(res.json().data.permissions, []);
    const blocked = await h.request('GET', '/api/v1/permissions', { token });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error.code, 'AUTH_STEP_REQUIRED');
  });

  it('enrolamiento: código incorrecto 422; correcto entrega 10 códigos de recuperación y rota la sesión', async () => {
    const user = await h.localUser('admin-enroll', { roles: [h.roles.admin] });
    const { token } = await h.login(user.username);
    const start = await h.request('POST', '/api/v1/auth/mfa/enroll/start', { token, payload: {} });
    assert.equal(start.statusCode, 200);
    const { secret, otpauthUri } = start.json().data;
    assert.match(otpauthUri, /^otpauth:\/\/totp\/EnvioTec:/);
    const svg = Buffer.from(start.json().data.qrDataUri.replace('data:image/svg+xml;base64,', ''), 'base64').toString();
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.ok(!/<script|on\w+=/i.test(svg), 'el SVG no lleva scripts ni handlers');
    const wrong = await h.request('POST', '/api/v1/auth/mfa/enroll/confirm', { token, payload: { code: '000000' } });
    assert.equal(wrong.statusCode, 422);
    const ok = await h.request('POST', '/api/v1/auth/mfa/enroll/confirm', { token, payload: { code: totpFor(secret) } });
    assert.equal(ok.statusCode, 200);
    const { recoveryCodes, session } = ok.json().data;
    assert.equal(recoveryCodes.length, 10);
    assert.equal(session.stage, 'full');
    const newToken = h.tokenFrom(ok);
    assert.notEqual(newToken, token);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token })).statusCode, 401, 'el token anterior deja de valer');
    assert.equal((await h.request('GET', '/api/v1/permissions', { token: newToken })).statusCode, 200);

    const { rows } = await h.owner.query('SELECT mfa_secret_encrypted FROM users WHERE id = $1', [user.id]);
    assert.ok(!rows[0].mfa_secret_encrypted.toString('latin1').includes(secret), 'el secreto se guarda cifrado');
    const codes = await h.owner.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [user.id]);
    assert.equal(codes.rowCount, 10);
    assert.equal((await h.audits('auth.mfa_enable', user.id)).length, 1);
  });

  it('verificación: el código no se puede reutilizar; uno nuevo sí; el de recuperación vale una vez', async () => {
    const { user, secret, code, confirm } = await enrolledAdmin('admin-verify');
    const recovery = confirm.json().data.recoveryCodes[0];

    const second = await h.login(user.username);
    assert.equal(second.res.json().data.stage, 'mfa_verify');
    const replay = await h.request('POST', '/api/v1/auth/mfa/verify', { token: second.token, payload: { code } });
    assert.equal(replay.statusCode, 422, 'el mismo código ya se usó al enrolar');
    const next = await h.request('POST', '/api/v1/auth/mfa/verify', { token: second.token, payload: { code: totpFor(secret, 1) } });
    assert.equal(next.statusCode, 200);
    assert.equal(next.json().data.stage, 'full');

    const third = await h.login(user.username);
    const first = await h.request('POST', '/api/v1/auth/mfa/verify', { token: third.token, payload: { recoveryCode: recovery } });
    assert.equal(first.statusCode, 200);
    const fourth = await h.login(user.username);
    const again = await h.request('POST', '/api/v1/auth/mfa/verify', { token: fourth.token, payload: { recoveryCode: recovery } });
    assert.equal(again.statusCode, 422);
  });

  it('5 códigos incorrectos en una sesión la revocan', async () => {
    const { user } = await enrolledAdmin('admin-brute');
    const { token } = await h.login(user.username);
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await h.request('POST', '/api/v1/auth/mfa/verify', { token, payload: { code: '123456' } })).statusCode);
    }
    assert.deepEqual(statuses, [422, 422, 422, 422, 401]);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token })).statusCode, 401);
  });

  it('contraseña inicial: obliga a cambiarla; la política rechaza contraseñas débiles; revoca las otras sesiones', async () => {
    const user = await h.localUser('first-login', { roles: [h.roles.viewer], mustChangePassword: true });
    const other = await h.login(user.username);
    const { res, token } = await h.login(user.username);
    assert.equal(res.json().data.stage, 'password_change');
    assert.equal((await h.request('GET', '/api/v1/auth/sessions', { token })).json().error.code, 'AUTH_STEP_REQUIRED');

    const weak = await h.request('POST', '/api/v1/auth/password/change', {
      token, payload: { currentPassword: PASSWORD, newPassword: 'Password2026!' },
    });
    assert.equal(weak.statusCode, 422);
    assert.ok(weak.json().error.details.some((d) => d.code === 'common'));
    const badCurrent = await h.request('POST', '/api/v1/auth/password/change', {
      token, payload: { currentPassword: 'otra', newPassword: NEW_PASSWORD },
    });
    assert.equal(badCurrent.statusCode, 422);

    const ok = await h.request('POST', '/api/v1/auth/password/change', {
      token, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().data.stage, 'full');
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: other.token })).statusCode, 401);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: h.tokenFrom(ok) })).statusCode, 200);
    assert.equal((await h.login(user.username, NEW_PASSWORD)).res.statusCode, 200);
  });

  it('recuperación por correo: misma respuesta exista o no la cuenta; token de un solo uso; revoca sesiones', async () => {
    const user = await h.localUser('forgot', { roles: [h.roles.viewer] });
    const session = await h.login(user.username);
    mailer.sent.length = 0;

    const known = await h.request('POST', '/api/v1/auth/password/forgot', { payload: { email: user.email } });
    const unknown = await h.request('POST', '/api/v1/auth/password/forgot', { payload: { email: `${h.prefix}@nadie.test` } });
    assert.equal(known.statusCode, 202);
    assert.equal(unknown.statusCode, 202);
    assert.deepEqual(known.json(), unknown.json());

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, user.email);
    const token = new URL(mailer.sent[0].text.match(/https:\/\/\S+/)[0].replace('/#/', '/')).searchParams.get('token');
    const { rows } = await h.owner.query('SELECT token_hash FROM password_reset_tokens WHERE user_id = $1', [user.id]);
    assert.ok(rows[0].token_hash.equals(hashToken(token)), 'en la base solo está el hash');

    const reset = await h.request('POST', '/api/v1/auth/password/reset', { payload: { token, newPassword: NEW_PASSWORD } });
    assert.equal(reset.statusCode, 200);
    const reuse = await h.request('POST', '/api/v1/auth/password/reset', { payload: { token, newPassword: `${NEW_PASSWORD}x` } });
    assert.equal(reuse.statusCode, 422);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: session.token })).statusCode, 401);
    assert.equal((await h.login(user.username, NEW_PASSWORD)).res.statusCode, 200);
  });

  it('un token de recuperación vencido no sirve', async () => {
    const user = await h.localUser('expired-token');
    await h.request('POST', '/api/v1/auth/password/forgot', { payload: { email: user.email } });
    await new Promise((resolve) => setImmediate(resolve));
    const token = new URL(mailer.sent.at(-1).text.match(/https:\/\/\S+/)[0].replace('/#/', '/')).searchParams.get('token');
    await h.owner.query("UPDATE password_reset_tokens SET created_at = now() - interval '40 minutes', expires_at = now() - interval '15 minutes' WHERE user_id = $1", [user.id]);
    const res = await h.request('POST', '/api/v1/auth/password/reset', { payload: { token, newPassword: NEW_PASSWORD } });
    assert.equal(res.statusCode, 422);
  });

  it('reinicio de MFA por un administrador: exige re-autenticación y emite el código de enrolamiento de AD', async () => {
    const { token: adminToken, secret } = await enrolledAdmin('admin-reset');
    const adUser = await h.adUser('ad-target');
    const target = await h.login(adUser.username);
    assert.equal(target.res.statusCode, 401, 'sin AD habilitado la cuenta de AD no entra');

    // Enrolling MFA counts as a reauthentication (A5); it is aged past the 5 minutes.
    await h.owner.query("UPDATE sessions SET reauth_at = now() - interval '6 minutes' WHERE id = $1", [hashToken(adminToken)]);
    const noReauth = await h.request('POST', `/api/v1/users/${adUser.id}/mfa/reset`, { token: adminToken });
    assert.equal(noReauth.statusCode, 403);
    assert.equal(noReauth.json().error.code, 'REAUTH_REQUIRED');

    await h.request('POST', '/api/v1/auth/reauth', { token: adminToken, payload: { code: totpFor(secret, 1) } });
    const res = await h.request('POST', `/api/v1/users/${adUser.id}/mfa/reset`, { token: adminToken });
    assert.equal(res.statusCode, 200);
    const { enrollmentCode, expiresAt } = res.json().data;
    assert.ok(enrollmentCode.split('-').every((group) => /^[A-Z2-7]{4}$/.test(group)) && enrollmentCode.length === 19);
    assert.ok(new Date(expiresAt) > new Date());
    const { rows } = await h.owner.query('SELECT code_hash, issued_by FROM mfa_enrollment_codes WHERE user_id = $1', [adUser.id]);
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].code_hash.toString('latin1').includes(enrollmentCode));
    assert.equal((await h.audits('user.mfa_enrollment_code_issue', adUser.id)).length, 1);

    const self = await h.owner.query('SELECT user_id FROM sessions WHERE id = $1', [hashToken(adminToken)]);
    const selfReset = await h.request('POST', `/api/v1/users/${self.rows[0].user_id}/mfa/reset`, { token: adminToken });
    assert.equal(selfReset.statusCode, 409);
  });

  it('la cadena de auditoría queda enlazada y cada hash se puede recalcular', async () => {
    const { rows } = await h.owner.query(
      `SELECT seq, hash, prev_hash, hash = audit_log_canonical(id, occurred_at, actor_type, actor_user_id, actor_session_id,
              action, resource_type, resource_id, result, ip, user_agent, request_id, metadata, prev_hash) AS valid
         FROM audit_logs ORDER BY seq DESC LIMIT 50`,
    );
    assert.ok(rows.length > 10);
    for (let i = 0; i < rows.length - 1; i += 1) {
      assert.ok(rows[i].valid, `hash del registro ${rows[i].seq}`);
      assert.ok(rows[i].prev_hash.equals(rows[i + 1].hash), `enlace del registro ${rows[i].seq}`);
    }
  });
});
