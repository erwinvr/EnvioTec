import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidCredentialsError } from 'ldapts';
import { createAdProvider } from '../../src/core/auth/providers/ad.provider.js';
import {
  escapeFilterValue, guidToUuid, isAccountDisabled, isAccountExpired,
} from '../../src/core/auth/providers/ldap-utils.js';
import { ServiceUnavailableError } from '../../src/core/errors/errors.js';

describe('utilidades de LDAP', () => {
  it('escapa los caracteres especiales de un filtro (RFC 4515, LDAP injection)', () => {
    assert.equal(escapeFilterValue('ana'), 'ana');
    assert.equal(escapeFilterValue('*)(objectClass=*'), '\\2a\\29\\28objectClass=\\2a');
    assert.equal(escapeFilterValue('a\\b'), 'a\\5cb');
    assert.equal(escapeFilterValue('\u0000'), '\\00');
    assert.equal(escapeFilterValue('ñ'), '\\c3\\b1');
  });

  it('convierte objectGUID (bytes de Microsoft) a UUID', () => {
    const bytes = Buffer.from('33221100554477668899aabbccddeeff', 'hex');
    assert.equal(guidToUuid(bytes), '00112233-4455-6677-8899-aabbccddeeff');
    assert.equal(guidToUuid(Buffer.alloc(3)), null);
    assert.equal(guidToUuid('texto'), null);
  });

  it('interpreta userAccountControl y accountExpires', () => {
    assert.equal(isAccountDisabled('512'), false);
    assert.equal(isAccountDisabled('514'), true);
    assert.equal(isAccountDisabled('basura'), true);
    assert.equal(isAccountExpired('0'), false);
    assert.equal(isAccountExpired('9223372036854775807'), false);
    assert.equal(isAccountExpired(undefined), false);
    // 2000-01-01 and 2200-01-01 as FILETIME.
    assert.equal(isAccountExpired('125911584000000000'), true);
    assert.equal(isAccountExpired('189022752000000000'), false);
    assert.equal(isAccountExpired('no-numero'), true);
  });
});

const CONFIG = {
  enabled: true, url: 'ldaps://dc.test', caCert: 'pem', bindDn: 'CN=svc,DC=test', bindPassword: 'x',
  baseDn: 'DC=test', allowedGroupDn: 'CN=EnvioTec,DC=test', timeoutMs: 1000,
};
const ENTRY = {
  dn: 'CN=Ana,DC=test', objectGUID: Buffer.from('33221100554477668899aabbccddeeff', 'hex'), sAMAccountName: 'ana',
  mail: 'ana@empresa.test', displayName: 'Ana', department: 'Ventas', userAccountControl: '512', accountExpires: '0',
};

// Fake LDAP server: users with passwords and group memberships.
function fakeDirectory({ entries = [ENTRY], password = 'clave-correcta', groups = [CONFIG.allowedGroupDn], down = false } = {}) {
  const calls = [];
  const factory = () => ({
    async bind(dn, given) {
      calls.push({ op: 'bind', dn });
      if (down) throw new Error('ECONNREFUSED');
      if (dn === CONFIG.bindDn) return;
      if (!Object.is(given, password)) throw new InvalidCredentialsError('bad');
    },
    async search(base, options) {
      calls.push({ op: 'search', base, filter: options.filter });
      if (options.scope === 'base') {
        const group = options.filter.match(/:=(.*)\)$/)[1];
        return { searchEntries: groups.map(escapeFilterValue).includes(group) ? [{ dn: base }] : [] };
      }
      return { searchEntries: entries };
    },
    async unbind() {},
  });
  return { factory, calls };
}

describe('proveedor de AD', () => {
  it('autentica con el DN del usuario y devuelve sus datos', async () => {
    const { factory, calls } = fakeDirectory();
    const ad = createAdProvider(CONFIG, { clientFactory: factory });
    const result = await ad.authenticate('ana', 'clave-correcta');
    assert.equal(result.status, 'ok');
    assert.equal(result.entry.objectGuid, '00112233-4455-6677-8899-aabbccddeeff');
    assert.equal(result.entry.department, 'Ventas');
    assert.ok(calls.some((call) => call.op === 'bind' && call.dn === ENTRY.dn));
  });

  it('el usuario de la búsqueda va escapado en el filtro', async () => {
    const { factory, calls } = fakeDirectory({ entries: [] });
    const ad = createAdProvider(CONFIG, { clientFactory: factory });
    await ad.authenticate('*)(sAMAccountName=*', 'x');
    const search = calls.find((call) => call.op === 'search');
    assert.ok(search.filter.includes('\\2a\\29\\28sAMAccountName=\\2a'));
  });

  it('contraseña vacía: se rechaza sin contactar AD', async () => {
    const { factory, calls } = fakeDirectory();
    const ad = createAdProvider(CONFIG, { clientFactory: factory });
    assert.deepEqual(await ad.authenticate('ana', ''), { status: 'invalid' });
    assert.equal(calls.length, 0);
  });

  it('contraseña incorrecta, usuario inexistente o ambiguo: inválido', async () => {
    const ad = createAdProvider(CONFIG, { clientFactory: fakeDirectory().factory });
    assert.equal((await ad.authenticate('ana', 'otra')).status, 'invalid');
    const none = createAdProvider(CONFIG, { clientFactory: fakeDirectory({ entries: [] }).factory });
    assert.equal((await none.authenticate('nadie', 'x')).status, 'invalid');
    const two = createAdProvider(CONFIG, { clientFactory: fakeDirectory({ entries: [ENTRY, ENTRY] }).factory });
    assert.equal((await two.authenticate('ana', 'clave-correcta')).status, 'invalid');
  });

  it('AD caído: 503, nunca cuenta como intento fallido', async () => {
    const ad = createAdProvider(CONFIG, { clientFactory: fakeDirectory({ down: true }).factory });
    await assert.rejects(ad.authenticate('ana', 'x'), ServiceUnavailableError);
  });

  it('evalúa cuenta deshabilitada, vencida y pertenencia al grupo habilitado', async () => {
    const ad = createAdProvider(CONFIG, { clientFactory: fakeDirectory({ groups: [CONFIG.allowedGroupDn, 'CN=Operadores,DC=test'] }).factory });
    const { entry } = await ad.authenticate('ana', 'clave-correcta');
    const ok = await ad.evaluate(entry, ['CN=Operadores,DC=test', 'CN=Aprobadores,DC=test']);
    assert.equal(ok.allowed, true);
    assert.deepEqual([...ok.groups], ['CN=Operadores,DC=test']);
    assert.equal((await ad.evaluate({ ...entry, disabled: true })).reason, 'ad_account_disabled');
    assert.equal((await ad.evaluate({ ...entry, expired: true })).reason, 'ad_account_expired');

    const outside = createAdProvider(CONFIG, { clientFactory: fakeDirectory({ groups: [] }).factory });
    assert.equal((await outside.evaluate(entry)).reason, 'ad_not_in_group');
  });

  it('la pertenencia se consulta con LDAP_MATCHING_RULE_IN_CHAIN (grupos anidados) sobre el DN del usuario', async () => {
    const { factory, calls } = fakeDirectory();
    const ad = createAdProvider(CONFIG, { clientFactory: factory });
    const { entry } = await ad.authenticate('ana', 'clave-correcta');
    await ad.evaluate(entry);
    const membership = calls.find((call) => call.op === 'search' && call.base === ENTRY.dn);
    assert.equal(membership.filter, '(memberOf:1.2.840.113556.1.4.1941:=CN=EnvioTec,DC=test)');
  });

  it('con AD_ENABLED=false el proveedor queda deshabilitado', () => {
    assert.deepEqual(createAdProvider({ enabled: false }), { enabled: false });
  });
});
