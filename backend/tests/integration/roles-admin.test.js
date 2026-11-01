// Roles, effective permissions, AD group mappings and system parameters
// (A6, ADR-007, Parte B) against the real PostgreSQL and Redis.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHarness } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const ADMIN = ['roles.view', 'roles.create', 'roles.update', 'roles.delete', 'roles.assign', 'users.view',
  'directory.manage', 'settings.manage', 'areas.view_all', 'campaigns.view', 'campaigns.submit', 'reports.view'];

describe('roles, permisos, equivalencias de AD y parámetros', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let token;
  let superadminId;
  const call = (method, url, payload, t = token) => h.request(method, url, { token: t, payload });
  const createRole = (name, permissions = []) => call('POST', '/api/v1/roles', { name: `${h.prefix}-${name}`, permissions });

  before(async () => {
    h = await createHarness();
    await h.role('admin', ADMIN);
    const admin = await h.localUser('admin', { roles: [h.roles.admin], mfa: true });
    token = await h.session(admin.id);
    superadminId = (await h.owner.query("SELECT id FROM roles WHERE name = 'superadmin'")).rows[0].id;
  });
  after(async () => {
    await h?.owner.query('DELETE FROM ad_group_role_mappings WHERE group_dn LIKE $1', [`%${h.prefix}%`]);
    await h?.close();
  });

  it('crea, edita, cambia permisos y borra un rol, auditando cada paso', async () => {
    const created = await createRole('ciclo', ['campaigns.view']);
    assert.equal(created.statusCode, 201);
    const { id } = created.json().data;
    assert.deepEqual(created.json().data.permissions, ['campaigns.view']);
    const renamed = await call('PATCH', `/api/v1/roles/${id}`, { name: `${h.prefix}-renombrado`, description: 'Prueba' });
    assert.equal(renamed.json().data.name, `${h.prefix}-renombrado`);
    const changed = await call('PUT', `/api/v1/roles/${id}/permissions`, { permissions: ['campaigns.submit', 'reports.view'] });
    assert.deepEqual(changed.json().data.permissions, ['campaigns.submit', 'reports.view']);
    const audit = (await h.audits('role.permissions_update', id)).at(-1);
    assert.deepEqual(audit.metadata.added.sort(), ['campaigns.submit', 'reports.view']);
    assert.deepEqual(audit.metadata.removed, ['campaigns.view']);
    assert.equal((await call('DELETE', `/api/v1/roles/${id}`)).statusCode, 200);
    assert.equal((await call('GET', `/api/v1/roles/${id}`)).statusCode, 404);
    assert.equal((await h.audits('role.delete', id)).length, 1);
  });

  it('rol de sistema: no se renombra, no cambia permisos y no se borra', async () => {
    assert.equal((await call('PATCH', `/api/v1/roles/${superadminId}`, { name: 'otro' })).statusCode, 409);
    assert.equal((await call('PUT', `/api/v1/roles/${superadminId}/permissions`, { permissions: [] })).statusCode, 409);
    assert.equal((await call('DELETE', `/api/v1/roles/${superadminId}`)).statusCode, 409);
  });

  it('escalamiento: crear o cambiar un rol con permisos propios ajenos es 403 auditado', async () => {
    const denied = await createRole('escala', ['settings.manage', 'audit.export']);
    assert.equal(denied.json().error.code, 'PRIVILEGE_ESCALATION');
    const { rows } = await h.owner.query("SELECT 1 FROM audit_logs WHERE action = 'role.create' AND result = 'denied' AND metadata->>'name' = $1",
      [`${h.prefix}-escala`]);
    assert.equal(rows.length, 1);
    const { id } = (await createRole('cambio')).json().data;
    const res = await call('PUT', `/api/v1/roles/${id}/permissions`, { permissions: ['audit.export'] });
    assert.equal(res.statusCode, 403);
    assert.equal((await h.audits('role.permissions_update', id)).at(-1).result, 'denied');
  });

  it('nadie cambia los permisos de un rol que tiene', async () => {
    const res = await call('PUT', `/api/v1/roles/${h.roles.admin}/permissions`, { permissions: ADMIN.slice(1) });
    assert.equal(res.statusCode, 409);
  });

  it('un rol en uso o mapeado desde AD no se borra; usado desde AD no recibe permisos administrativos', async () => {
    const { id } = (await createRole('en-uso', ['campaigns.view'])).json().data;
    const user = await h.localUser('con-rol', { roles: [id] });
    assert.equal((await call('DELETE', `/api/v1/roles/${id}`)).statusCode, 409);
    await h.owner.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);

    const mapped = await call('POST', '/api/v1/directory/mappings', { groupDn: `CN=${h.prefix}-g1,DC=empresa,DC=test`, roleId: id });
    assert.equal(mapped.statusCode, 201);
    assert.equal((await call('DELETE', `/api/v1/roles/${id}`)).statusCode, 409);
    const admin = await call('PUT', `/api/v1/roles/${id}/permissions`, { permissions: ['campaigns.view', 'roles.create'] });
    assert.equal(admin.json().error.details[0].code, 'administrative_permission_for_ad_role');
  });

  it('cambiar los permisos de un rol revoca las sesiones de sus usuarios', async () => {
    const { id } = (await createRole('sesiones', ['campaigns.view'])).json().data;
    const user = await h.localUser('sesiones', { roles: [id] });
    const session = await h.login(user.username);
    await call('PUT', `/api/v1/roles/${id}/permissions`, { permissions: ['campaigns.view', 'reports.view'] });
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: session.token })).statusCode, 401);
    const again = await h.login(user.username);
    assert.deepEqual(again.res.json().data.permissions, ['campaigns.view', 'reports.view']);
  });

  it('permisos efectivos: cada permiso con sus roles y si exige MFA', async () => {
    const { id } = (await createRole('efectivo', ['campaigns.submit'])).json().data;
    const user = await h.localUser('efectivo', { roles: [id, h.roles.admin] });
    const res = await call('GET', `/api/v1/users/${user.id}/permissions`);
    const { mfaRequired, permissions } = res.json().data;
    assert.equal(mfaRequired, true);
    const submit = permissions.find((p) => p.code === 'campaigns.submit');
    assert.deepEqual(submit.roles.sort(), [`${h.prefix}-admin`, `${h.prefix}-efectivo`].sort());
  });

  it('equivalencias de AD: DN validado, solo roles de negocio, únicas, auditadas y borrables', async () => {
    const { id } = (await createRole('negocio', ['campaigns.view'])).json().data;
    const groupDn = `CN=${h.prefix}-g2,OU=Grupos,DC=empresa,DC=test`;
    assert.equal((await call('POST', '/api/v1/directory/mappings', { groupDn: 'no es un dn', roleId: id })).json().error.details[0].code, 'invalid_dn');
    const adminRole = await call('POST', '/api/v1/directory/mappings', { groupDn, roleId: h.roles.admin });
    assert.equal(adminRole.json().error.details[0].code, 'administrative_role');
    const created = await call('POST', '/api/v1/directory/mappings', { groupDn, roleId: id });
    assert.equal(created.statusCode, 201);
    assert.equal((await call('POST', '/api/v1/directory/mappings', { groupDn, roleId: id })).statusCode, 409);
    const list = await call('GET', '/api/v1/directory/mappings');
    assert.ok(list.json().data.some((m) => m.groupDn === groupDn && m.roleName === `${h.prefix}-negocio`));
    assert.equal((await call('DELETE', `/api/v1/directory/mappings/${created.json().data.id}`)).statusCode, 200);
    assert.equal((await h.audits('directory.mapping_delete', created.json().data.id)).length, 1);
  });

  it('parámetros: rango, listas, coherencia, re-autenticación y auditoría con valor anterior y nuevo', async () => {
    const key = 'local_account.default_validity_days';
    const { rows } = await h.owner.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    const original = rows[0].value;
    try {
      const list = await call('GET', '/api/v1/settings');
      assert.ok(list.json().data.some((s) => s.key === key && s.min === 1));
      assert.equal((await call('PATCH', `/api/v1/settings/${key}`, { value: 400 })).json().error.details[0].code, 'out_of_range');
      assert.equal((await call('PATCH', `/api/v1/settings/${key}`, { value: 181 })).json().error.details[0].code, 'above_maximum');
      assert.equal((await call('PATCH', '/api/v1/settings/notifications.admin_emails', { value: ['x'] })).json().error.details[0].code, 'invalid_email');
      assert.equal((await call('PATCH', '/api/v1/settings/no.existe', { value: 1 })).statusCode, 404);
      const noReauth = await h.session((await h.owner.query('SELECT user_id FROM user_roles WHERE role_id = $1 LIMIT 1', [h.roles.admin])).rows[0].user_id, { reauth: false });
      assert.equal((await call('PATCH', `/api/v1/settings/${key}`, { value: 60 }, noReauth)).json().error.code, 'REAUTH_REQUIRED');
      const ok = await call('PATCH', `/api/v1/settings/${key}`, { value: 60 });
      assert.equal(ok.json().data.value, 60);
      const audit = await h.audits('setting.update', key);
      assert.deepEqual([audit.at(-1).metadata.before, audit.at(-1).metadata.after], [original, 60]);
    } finally {
      await h.owner.query('UPDATE system_settings SET value = $2::jsonb WHERE key = $1', [key, JSON.stringify(original)]);
    }
  });
});
