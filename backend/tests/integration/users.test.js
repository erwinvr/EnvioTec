// Users and areas API (A6, A8, Parte B) against the real PostgreSQL and Redis:
// lifecycle of local accounts, area scope (IDOR), mass assignment and the
// anti-escalation rules.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHarness } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const ADMIN_PERMISSIONS = ['users.view', 'users.update', 'users.disable', 'users.reset_password', 'users.unlock',
  'users.create_local', 'users.renew_local', 'roles.assign', 'sessions.view_any', 'sessions.revoke_any',
  'areas.manage', 'campaigns.view', 'campaigns.submit'];

describe('API de usuarios y áreas', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let admin;
  let adminToken;
  let areaAdminToken;
  let otherArea;
  let superadminRole;

  const as = (token) => ({
    get: (url) => h.request('GET', url, { token }),
    post: (url, payload) => h.request('POST', url, { token, payload }),
    patch: (url, payload) => h.request('PATCH', url, { token, payload }),
    put: (url, payload) => h.request('PUT', url, { token, payload }),
    del: (url) => h.request('DELETE', url, { token }),
  });
  const newUser = (name, extra = {}) => as(adminToken).post('/api/v1/users', {
    username: `${h.prefix}.${name}`, email: `${h.prefix}.${name}@empresa.test`, displayName: `Usuario ${name}`,
    areaId: h.areaId, ...extra,
  });

  before(async () => {
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_ACCOUNT: '50' } });
    await h.role('admin', [...ADMIN_PERMISSIONS, 'areas.view_all']);
    await h.role('area-admin', ADMIN_PERMISSIONS);
    await h.role('operador', ['campaigns.view', 'campaigns.submit']);
    await h.role('admin-ish', ['users.update']);
    const { rows } = await h.owner.query("SELECT id FROM roles WHERE name = 'superadmin'");
    superadminRole = rows[0].id;
    otherArea = await h.area('otra');
    admin = await h.localUser('admin', { roles: [h.roles.admin], mfa: true });
    adminToken = await h.session(admin.id);
    const areaAdmin = await h.localUser('area-admin', { roles: [h.roles['area-admin']], mfa: true });
    areaAdminToken = await h.session(areaAdmin.id);
  });
  after(() => h?.close());

  it('alta de cuenta local: contraseña temporal de un solo uso visible, cambio obligatorio en el primer login', async () => {
    const res = await newUser('alta');
    assert.equal(res.statusCode, 201);
    const { user, temporaryPassword } = res.json().data;
    assert.equal(temporaryPassword.length, 20);
    assert.equal(user.mustChangePassword, true);
    assert.equal(user.authSource, 'local');
    const login = await h.login(user.username, temporaryPassword);
    assert.equal(login.res.json().data.stage, 'password_change');
    assert.equal((await h.audits('user.create', user.id)).length, 1);
    assert.equal((await as(adminToken).get(`/api/v1/users/${user.id}`)).body.includes(temporaryPassword), false);
  });

  it('alta: mass assignment, duplicados, vigencia y área se validan', async () => {
    assert.equal((await newUser('mass', { status: 'active' })).statusCode, 422);
    assert.equal((await newUser('mass', { passwordHash: 'x' })).statusCode, 422);
    assert.equal((await newUser('mass', { roles: ['superadmin'] })).statusCode, 422);
    await newUser('dup');
    assert.equal((await newUser('dup')).statusCode, 409);
    const far = new Date(Date.now() + 200 * 86400000).toISOString();
    assert.equal((await newUser('far', { expiresAt: far })).json().error.details[0].code, 'exceeds_max_validity');
    const res = await as(areaAdminToken).post('/api/v1/users', {
      username: `${h.prefix}.fuera`, email: `${h.prefix}.fuera@empresa.test`, displayName: 'Fuera', areaId: otherArea,
    });
    assert.equal(res.json().error.details[0].code, 'invalid_area');
  });

  it('alcance por área: sin areas.view_all solo ve su área; otra área responde 404 (IDOR)', async () => {
    const outside = await h.localUser('outside', { area: otherArea });
    const listed = await as(areaAdminToken).get('/api/v1/users?pageSize=100');
    assert.ok(listed.json().data.every((u) => u.areaId === h.areaId));
    assert.equal((await as(areaAdminToken).get(`/api/v1/users/${outside.id}`)).statusCode, 404);
    assert.equal((await as(areaAdminToken).post(`/api/v1/users/${outside.id}/disable`)).statusCode, 404);
    assert.equal((await as(adminToken).get(`/api/v1/users/${outside.id}`)).statusCode, 200);
    const filtered = await as(adminToken).get(`/api/v1/users?areaId=${otherArea}`);
    assert.deepEqual(filtered.json().data.map((u) => u.id), [outside.id]);
  });

  it('listado: búsqueda literal, orden por allowlist y paginación validada', async () => {
    const searched = await h.localUser('busca');
    await h.owner.query("UPDATE users SET display_name = $2 WHERE id = $1", [searched.id, `Descuento 100% ${h.prefix}`]);
    await h.owner.query("UPDATE users SET display_name = $2 WHERE id = $1", [(await h.localUser('busca2')).id, `Descuento 1000 ${h.prefix}`]);
    const res = await as(adminToken).get(`/api/v1/users?search=${encodeURIComponent('100%')}&sort=createdAt&direction=desc`);
    assert.equal(res.json().meta.total, 1);
    assert.equal((await as(adminToken).get('/api/v1/users?sort=password_hash')).statusCode, 422);
    assert.equal((await as(adminToken).get('/api/v1/users?pageSize=500')).statusCode, 422);
  });

  it('edición: datos de AD no se editan; cambiar el email exige re-autenticación', async () => {
    const adUser = await h.adUser('ad-edit');
    assert.equal((await as(adminToken).patch(`/api/v1/users/${adUser.id}`, { displayName: 'X' })).statusCode, 409);
    const target = await h.localUser('edit');
    const noReauth = await h.session(admin.id, { reauth: false });
    const denied = await as(noReauth).patch(`/api/v1/users/${target.id}`, { email: `${h.prefix}.nuevo@empresa.test` });
    assert.equal(denied.json().error.code, 'REAUTH_REQUIRED');
    assert.equal((await as(noReauth).patch(`/api/v1/users/${target.id}`, { displayName: 'Nuevo nombre' })).statusCode, 200);
    const ok = await as(adminToken).patch(`/api/v1/users/${target.id}`, { email: `${h.prefix}.nuevo@empresa.test` });
    assert.equal(ok.json().data.email, `${h.prefix}.nuevo@empresa.test`);
    const audit = await h.audits('user.update', target.id);
    assert.deepEqual(audit.at(-1).metadata.before, { email: target.email });
    assert.equal((await as(adminToken).patch(`/api/v1/users/${target.id}`, { status: 'disabled' })).statusCode, 422);
  });

  it('desactivar: no a uno mismo; revoca sesiones; reactivar una cuenta vencida exige renovarla', async () => {
    assert.equal((await as(adminToken).post(`/api/v1/users/${admin.id}/disable`)).statusCode, 409);
    const target = await h.localUser('disable');
    const session = await h.login(target.username);
    const res = await as(adminToken).post(`/api/v1/users/${target.id}/disable`);
    assert.equal(res.json().data.status, 'disabled');
    assert.equal(res.json().data.disabledReason, 'manual');
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: session.token })).statusCode, 401);
    assert.equal((await h.login(target.username)).res.statusCode, 401);
    assert.equal((await as(adminToken).post(`/api/v1/users/${target.id}/enable`)).json().data.status, 'active');
    assert.equal((await h.login(target.username)).res.statusCode, 200);

    const expired = await h.localUser('expired-enable', { expiresInMinutes: -10 });
    await h.owner.query("UPDATE users SET status = 'disabled', disabled_reason = 'expired', disabled_at = now() WHERE id = $1", [expired.id]);
    assert.equal((await as(adminToken).post(`/api/v1/users/${expired.id}/enable`)).statusCode, 409);
  });

  it('regla 3: no se desactiva ni se quita el rol al último superadmin activo', async () => {
    const only = await h.localUser('super-1', { roles: [superadminRole], mfa: true });
    assert.equal((await as(adminToken).post(`/api/v1/users/${only.id}/disable`)).statusCode, 409);
    const second = await h.localUser('super-2', { roles: [superadminRole], mfa: true });
    const secondToken = await h.session(second.id);
    assert.equal((await as(secondToken).put(`/api/v1/users/${only.id}/roles`, { roleIds: [] })).statusCode, 200);
    assert.equal((await as(adminToken).post(`/api/v1/users/${second.id}/disable`)).statusCode, 409);
  });

  it('roles: asigna lo que el actor tiene y revoca las sesiones del usuario', async () => {
    const target = await h.localUser('roles');
    const session = await h.login(target.username);
    const res = await as(adminToken).put(`/api/v1/users/${target.id}/roles`, { roleIds: [h.roles.operador] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.roles.map((r) => r.name), [`${h.prefix}-operador`]);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: session.token })).statusCode, 401);
    assert.deepEqual((await h.audits('user.roles_update', target.id)).at(-1).metadata.added, [`${h.prefix}-operador`]);
  });

  it('roles: escalamiento (403 auditado), propios roles (409) y rol administrativo a AD (422)', async () => {
    const target = await h.localUser('escala');
    const escalation = await as(adminToken).put(`/api/v1/users/${target.id}/roles`, { roleIds: [superadminRole] });
    assert.equal(escalation.statusCode, 403);
    assert.equal(escalation.json().error.code, 'PRIVILEGE_ESCALATION');
    assert.equal((await h.audits('user.roles_update', target.id)).at(-1).result, 'denied');
    assert.equal((await as(adminToken).put(`/api/v1/users/${admin.id}/roles`, { roleIds: [] })).statusCode, 409);
    const adUser = await h.adUser('ad-roles');
    const res = await as(adminToken).put(`/api/v1/users/${adUser.id}/roles`, { roleIds: [h.roles['admin-ish']] });
    assert.equal(res.json().error.details[0].code, 'administrative_role_for_ad');
  });

  it('reset de contraseña: solo local, temporal, cambio obligatorio y sesiones revocadas', async () => {
    const adUser = await h.adUser('ad-reset');
    assert.equal((await as(adminToken).post(`/api/v1/users/${adUser.id}/reset-password`)).statusCode, 409);
    const target = await h.localUser('reset');
    const session = await h.login(target.username);
    const { temporaryPassword } = (await as(adminToken).post(`/api/v1/users/${target.id}/reset-password`)).json().data;
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: session.token })).statusCode, 401);
    assert.equal((await h.login(target.username, temporaryPassword)).res.json().data.stage, 'password_change');
  });

  it('renovación: motivo obligatorio, límites, nunca la propia, y reactiva una cuenta vencida', async () => {
    const reason = 'Renovación aprobada por la jefatura del área';
    assert.equal((await as(adminToken).post(`/api/v1/users/${admin.id}/renew`, { days: 30, reason })).statusCode, 409);
    const target = await h.localUser('renew', { expiresInMinutes: -60 });
    await h.owner.query("UPDATE users SET status = 'disabled', disabled_reason = 'expired', disabled_at = now() WHERE id = $1", [target.id]);
    assert.equal((await as(adminToken).post(`/api/v1/users/${target.id}/renew`, { days: 30, reason: 'corto' })).statusCode, 422);
    assert.equal((await as(adminToken).post(`/api/v1/users/${target.id}/renew`, { days: 91, reason })).json().error.details[0].code, 'exceeds_renewal_max');
    const res = await as(adminToken).post(`/api/v1/users/${target.id}/renew`, { days: 30, reason });
    assert.equal(res.json().data.status, 'active');
    assert.equal((await h.audits('user.renew', target.id))[0].metadata.reactivated, true);
    assert.equal((await h.login(target.username)).res.statusCode, 200);
    const adUser = await h.adUser('ad-renew');
    assert.equal((await as(adminToken).post(`/api/v1/users/${adUser.id}/renew`, { days: 30, reason })).statusCode, 409);
  });

  it('desbloqueo, sesiones de otro usuario y revisión de cuentas locales', async () => {
    const target = await h.localUser('unlock');
    await h.owner.query("UPDATE users SET failed_login_count = 9, locked_until = now() + interval '1 hour' WHERE id = $1", [target.id]);
    assert.equal((await h.login(target.username)).res.statusCode, 401);
    assert.equal((await as(adminToken).post(`/api/v1/users/${target.id}/unlock`)).json().data.lockedUntil, null);
    await h.login(target.username);
    const sessions = await as(adminToken).get(`/api/v1/users/${target.id}/sessions`);
    assert.equal(sessions.json().data.length, 1);
    assert.equal((await as(adminToken).del(`/api/v1/users/${target.id}/sessions`)).json().data.revoked, 1);
    const review = await as(adminToken).get('/api/v1/users/review/local?pageSize=100');
    const row = review.json().data.find((u) => u.id === target.id);
    assert.equal(row.inactiveDays, 0);
  });

  it('áreas: todos ven nombres; solo areas.manage ve el department de AD; nombres únicos', async () => {
    const basic = await h.localUser('basic');
    const { token } = await h.login(basic.username);
    const list = await as(token).get('/api/v1/areas');
    assert.ok(list.json().data.every((a) => !('adDepartment' in a)));
    assert.ok((await as(adminToken).get('/api/v1/areas')).json().data.some((a) => 'adDepartment' in a));
    const created = await as(adminToken).post('/api/v1/areas', { name: `${h.prefix}-Nueva`, adDepartment: `${h.prefix}-Dep2` });
    assert.equal(created.statusCode, 201);
    assert.equal((await as(adminToken).post('/api/v1/areas', { name: `${h.prefix}-nueva` })).statusCode, 409);
    const updated = await as(adminToken).patch(`/api/v1/areas/${created.json().data.id}`, { isActive: false });
    assert.equal(updated.json().data.isActive, false);
    assert.equal((await as(token).post('/api/v1/areas', { name: `${h.prefix}-x` })).statusCode, 403);
    assert.equal((await h.audits('area.update', created.json().data.id)).length, 1);
  });
});
