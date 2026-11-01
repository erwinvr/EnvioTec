import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidDn } from '../../src/modules/directory/dn.js';
import {
  assertDeletable, assertKnownPermissions, assertRenamable, checkNewRole, checkPermissionChange,
} from '../../src/modules/roles/roles.rules.js';
import { assertConsistent, normalizeSettingValue } from '../../src/modules/settings/settings.rules.js';

const CATALOG = new Map([
  ['campaigns.view', { administrative: false }],
  ['campaigns.submit', { administrative: false }],
  ['users.update', { administrative: true }],
  ['settings.manage', { administrative: true }],
]);
const actor = { roleIds: new Set(['mine']), permissions: new Set(['campaigns.view', 'campaigns.submit', 'users.update']) };
const role = { id: 'other', name: 'other', isSystem: false, usedFromAd: false };
const change = (overrides) => checkPermissionChange({
  actor, role, currentCodes: [], requestedCodes: [], catalog: CATALOG, ...overrides,
});
const is = (expected) => (error) => error.code === expected || error.statusCode === expected || error.details?.[0]?.code === expected;

describe('reglas de roles (A6)', () => {
  it('cambia permisos que el actor tiene y devuelve lo agregado y lo quitado', () => {
    assert.deepEqual(change({ currentCodes: ['campaigns.view'], requestedCodes: ['campaigns.submit', 'users.update'] }),
      { added: ['campaigns.submit', 'users.update'], removed: ['campaigns.view'] });
    assert.deepEqual(change({ currentCodes: ['campaigns.view'], requestedCodes: ['campaigns.view'] }), { added: [], removed: [] });
  });

  it('regla 4: un rol de sistema no cambia', () => {
    assert.throws(() => change({ role: { ...role, isSystem: true } }), is(409));
  });

  it('nadie cambia los permisos de un rol que tiene', () => {
    assert.throws(() => change({ role: { ...role, id: 'mine' } }), is(409));
  });

  it('regla 1: no otorga ni quita permisos que el actor no tiene', () => {
    assert.throws(() => change({ requestedCodes: ['settings.manage'] }), is('PRIVILEGE_ESCALATION'));
    assert.throws(() => change({ currentCodes: ['settings.manage'], requestedCodes: [] }), is('PRIVILEGE_ESCALATION'));
  });

  it('ADR-007: un rol usado desde AD no recibe permisos administrativos', () => {
    const adRole = { ...role, usedFromAd: true };
    assert.throws(() => change({ role: adRole, requestedCodes: ['users.update'] }), is('administrative_permission_for_ad_role'));
    assert.deepEqual(change({ role: adRole, requestedCodes: ['campaigns.view'] }), { added: ['campaigns.view'], removed: [] });
  });

  it('permisos inexistentes se rechazan', () => {
    assert.throws(() => change({ requestedCodes: ['nada.view'] }), is('unknown_permission'));
    assert.throws(() => assertKnownPermissions(['x.y'], CATALOG), is('unknown_permission'));
  });

  it('alta: solo con permisos que el creador tiene', () => {
    assert.doesNotThrow(() => checkNewRole({ actorPermissions: actor.permissions, codes: ['campaigns.view'], catalog: CATALOG }));
    assert.doesNotThrow(() => checkNewRole({ actorPermissions: actor.permissions, codes: [], catalog: CATALOG }));
    assert.throws(() => checkNewRole({ actorPermissions: actor.permissions, codes: ['settings.manage'], catalog: CATALOG }),
      is('PRIVILEGE_ESCALATION'));
  });

  it('el rol de sistema no se renombra; la descripción sí', () => {
    const system = { ...role, name: 'superadmin', isSystem: true };
    assert.throws(() => assertRenamable(system, { name: 'otro' }), is(409));
    assert.doesNotThrow(() => assertRenamable(system, { name: 'superadmin', description: 'x' }));
    assert.doesNotThrow(() => assertRenamable(system, { description: 'x' }));
    assert.doesNotThrow(() => assertRenamable(role, { name: 'otro' }));
  });

  it('regla 5 y 4: no se borra un rol en uso, mapeado desde AD o de sistema', () => {
    const base = { isSystem: false, userCount: 0, mappingCount: 0 };
    assert.doesNotThrow(() => assertDeletable(base));
    assert.throws(() => assertDeletable({ ...base, isSystem: true }), is(409));
    assert.throws(() => assertDeletable({ ...base, userCount: 1 }), is(409));
    assert.throws(() => assertDeletable({ ...base, mappingCount: 1 }), is(409));
  });
});

describe('validación de DN de grupos de AD', () => {
  it('acepta DN válidos, incluidas comas escapadas', () => {
    assert.ok(isValidDn('CN=EnvioTec-Usuarios,OU=Grupos,DC=empresa,DC=local'));
    assert.ok(isValidDn('CN=Ventas\\, Norte,DC=empresa,DC=local'));
  });

  it('rechaza DN mal formados', () => {
    for (const dn of ['', 'x', 'EnvioTec', 'CN=,DC=x', '=x,DC=y', 'CN=a,,DC=b', 'CN=a\\', '1N=a,DC=b', 'C'.repeat(501), 42]) {
      assert.equal(isValidDn(dn), false, String(dn).slice(0, 20));
    }
  });
});

describe('parámetros del sistema', () => {
  const integer = { value_type: 'integer', min_value: 1, max_value: 180 };

  it('enteros dentro del rango', () => {
    assert.equal(normalizeSettingValue(integer, 90), 90);
    assert.throws(() => normalizeSettingValue(integer, 0), is('out_of_range'));
    assert.throws(() => normalizeSettingValue(integer, 181), is('out_of_range'));
    assert.throws(() => normalizeSettingValue(integer, 1.5), is('invalid_type'));
    assert.throws(() => normalizeSettingValue(integer, ['1']), is('invalid_type'));
  });

  it('listas de emails y de dominios: normalizadas, sin duplicados y validadas', () => {
    assert.deepEqual(normalizeSettingValue({ value_type: 'email_list' }, [' TI@Empresa.test ', 'ti@empresa.test']), ['ti@empresa.test']);
    assert.throws(() => normalizeSettingValue({ value_type: 'email_list' }, ['no-es-email']), is('invalid_email'));
    assert.deepEqual(normalizeSettingValue({ value_type: 'string_list' }, ['Empresa.Local', 'sub.empresa.local']),
      ['empresa.local', 'sub.empresa.local']);
    for (const bad of ['localhost', '-x.com', 'x-.com', 'a..b', 'empresa.local/ruta', `${'a'.repeat(64)}.com`]) {
      assert.throws(() => normalizeSettingValue({ value_type: 'string_list' }, [bad]), is('invalid_domain'), bad);
    }
    assert.throws(() => normalizeSettingValue({ value_type: 'string_list' }, 'x'), is('invalid_type'));
    assert.throws(() => normalizeSettingValue({ value_type: 'string_list' }, [1]), is('invalid_type'));
    assert.throws(() => normalizeSettingValue({ value_type: 'email_list' }, Array.from({ length: 51 }, (_, i) => `a${i}@b.cl`)),
      is('too_many_items'));
  });

  it('coherencia: la vigencia por defecto y la renovación no superan la máxima', () => {
    const values = {
      'local_account.default_validity_days': 90, 'local_account.max_validity_days': 180, 'local_account.renewal_max_days': 90,
    };
    assert.doesNotThrow(() => assertConsistent('local_account.default_validity_days', 180, values));
    assert.throws(() => assertConsistent('local_account.default_validity_days', 181, values), is('above_maximum'));
    assert.throws(() => assertConsistent('local_account.max_validity_days', 60, values), is('below_dependent'));
    assert.doesNotThrow(() => assertConsistent('local_account.max_validity_days', 90, values));
    assert.doesNotThrow(() => assertConsistent('sending.monthly_global_cap', 5, values));
  });
});
