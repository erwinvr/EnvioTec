import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertKeepsASuperadmin, assertLocal, assertNotSelf, checkRoleChange, initialExpiry, renewedExpiry,
} from '../../src/modules/users/users.rules.js';

const ROLES = new Map([
  ['viewer', { id: 'viewer', name: 'viewer', permissions: ['campaigns.view'], administrative: false }],
  ['operator', { id: 'operator', name: 'operator', permissions: ['campaigns.view', 'campaigns.submit'], administrative: false }],
  ['admin', { id: 'admin', name: 'admin', permissions: ['users.view', 'users.update'], administrative: true }],
  ['superadmin', { id: 'superadmin', name: 'superadmin', permissions: ['users.view', 'users.update', 'settings.manage'], administrative: true }],
]);
const actor = { id: 'actor', permissions: new Set(['campaigns.view', 'campaigns.submit', 'users.view', 'users.update']) };
const local = { id: 'target', auth_source: 'local' };
const change = (overrides) => checkRoleChange({
  actor, target: local, currentRoles: [], requestedIds: [], rolesById: ROLES, ...overrides,
});
const code = (expected) => (error) => error.code === expected || error.details?.[0]?.code === expected;

describe('reglas contra escalamiento de privilegios (A6)', () => {
  it('asigna roles cuyos permisos el actor tiene, y devuelve lo agregado y quitado', () => {
    assert.deepEqual(change({ requestedIds: ['viewer', 'admin'] }), { added: ['viewer', 'admin'], removed: [] });
    assert.deepEqual(change({ currentRoles: [{ id: 'viewer', source: 'manual' }], requestedIds: ['operator'] }),
      { added: ['operator'], removed: ['viewer'] });
    assert.deepEqual(change({ currentRoles: [{ id: 'viewer', source: 'manual' }], requestedIds: ['viewer'] }),
      { added: [], removed: [] });
  });

  it('regla 1: no asigna un rol con permisos que el actor no tiene', () => {
    assert.throws(() => change({ requestedIds: ['superadmin'] }), code('PRIVILEGE_ESCALATION'));
  });

  it('regla 1: tampoco quita un rol con permisos que el actor no tiene', () => {
    assert.throws(() => change({ currentRoles: [{ id: 'superadmin', source: 'manual' }], requestedIds: [] }),
      code('PRIVILEGE_ESCALATION'));
  });

  it('regla 2: nadie modifica sus propios roles', () => {
    assert.throws(() => change({ target: { id: 'actor', auth_source: 'local' }, requestedIds: ['viewer'] }),
      (error) => error.statusCode === 409);
  });

  it('regla 4: una cuenta de AD no recibe roles administrativos', () => {
    const ad = { id: 'target', auth_source: 'ad' };
    assert.throws(() => change({ target: ad, requestedIds: ['admin'] }), code('administrative_role_for_ad'));
    assert.deepEqual(change({ target: ad, requestedIds: ['viewer'] }), { added: ['viewer'], removed: [] });
  });

  it('los roles que vienen de un grupo de AD no se editan a mano y se conservan', () => {
    const currentRoles = [{ id: 'operator', source: 'ad_group' }];
    assert.throws(() => change({ currentRoles, requestedIds: ['operator'] }), code('role_from_ad_group'));
    assert.deepEqual(change({ currentRoles, requestedIds: [] }), { added: [], removed: [] });
  });

  it('un rol inexistente se rechaza', () => {
    assert.throws(() => change({ requestedIds: ['nada'] }), code('unknown_role'));
  });

  it('regla 3: queda al menos un superadmin activo (sin contar la cuenta de emergencia)', () => {
    const base = { targetIsSuperadmin: true, targetIsEmergency: false, losesRole: true };
    assert.throws(() => assertKeepsASuperadmin({ ...base, otherActiveSuperadmins: 0 }), (error) => error.statusCode === 409);
    assert.doesNotThrow(() => assertKeepsASuperadmin({ ...base, otherActiveSuperadmins: 1 }));
    assert.doesNotThrow(() => assertKeepsASuperadmin({ ...base, targetIsEmergency: true, otherActiveSuperadmins: 0 }));
    assert.doesNotThrow(() => assertKeepsASuperadmin({ ...base, targetIsSuperadmin: false, otherActiveSuperadmins: 0 }));
    assert.doesNotThrow(() => assertKeepsASuperadmin({ ...base, losesRole: false, otherActiveSuperadmins: 0 }));
  });

  it('acciones sobre uno mismo y sobre cuentas de AD', () => {
    assert.throws(() => assertNotSelf('a', 'a', 'x'), (error) => error.statusCode === 409);
    assert.doesNotThrow(() => assertNotSelf('a', 'b', 'x'));
    assert.throws(() => assertLocal({ auth_source: 'ad' }), (error) => error.statusCode === 409);
    assert.doesNotThrow(() => assertLocal({ auth_source: 'local' }));
    assert.throws(() => assertLocal({ auth_source: 'ad' }, 'mensaje propio'), /mensaje propio/);
  });
});

describe('vigencia de cuentas locales', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const settings = { defaultDays: 90, maxDays: 180, renewalMaxDays: 90 };
  const day = 86400000;

  it('alta: vigencia por defecto, futura y nunca mayor al máximo', () => {
    assert.equal(initialExpiry(undefined, settings, now).getTime(), now + 90 * day);
    assert.equal(initialExpiry(new Date(now + 180 * day).toISOString(), settings, now).getTime(), now + 180 * day);
    assert.throws(() => initialExpiry(new Date(now + 181 * day).toISOString(), settings, now), code('exceeds_max_validity'));
    assert.throws(() => initialExpiry(new Date(now - 1).toISOString(), settings, now), code('in_the_past'));
  });

  it('renovación: extiende desde el vencimiento actual, hasta 90 días y sin pasar el máximo desde hoy', () => {
    assert.equal(renewedExpiry(new Date(now + 30 * day), 90, settings, now).getTime(), now + 120 * day);
    assert.equal(renewedExpiry(new Date(now - 10 * day), 30, settings, now).getTime(), now + 30 * day, 'vencida: desde hoy');
    assert.equal(renewedExpiry(null, 30, settings, now).getTime(), now + 30 * day, 'sin vencimiento previo: desde hoy');
    assert.throws(() => renewedExpiry(new Date(now + 30 * day), 91, settings, now), code('exceeds_renewal_max'));
    assert.throws(() => renewedExpiry(new Date(now + 100 * day), 90, settings, now), code('exceeds_max_validity'));
  });
});
