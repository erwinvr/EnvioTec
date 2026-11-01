// Simulated Active Directory behind the LDAP client factory (ADR-019).
import { randomBytes } from 'node:crypto';
import { InvalidCredentialsError } from 'ldapts';
import { escapeFilterValue } from '../../src/core/auth/providers/ldap-utils.js';
import { PASSWORD } from './auth-fixtures.js';

export const BIND_DN = 'CN=svc-enviotec,CN=Users,DC=empresa,DC=test';
export const ALLOWED = 'CN=EnvioTec-Usuarios,CN=Users,DC=empresa,DC=test';
export const OPERATORS = 'CN=EnvioTec-Operadores,CN=Users,DC=empresa,DC=test';
export const AD_ENV = {
  AD_ENABLED: 'true',
  LDAP_URL: 'ldaps://dc.empresa.test',
  LDAP_CA_CERT: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
  LDAP_BIND_DN: BIND_DN,
  LDAP_BIND_PASSWORD: 'clave-de-servicio',
  LDAP_BASE_DN: 'DC=empresa,DC=test',
  LDAP_ALLOWED_GROUP_DN: ALLOWED,
  RATE_LIMIT_LOGIN_PER_ACCOUNT: '50',
};

// Simulated AD: locks an account after 3 bad passwords, like the real one.
export function createDirectory() {
  const users = new Map();
  const state = { down: false, userBinds: 0 };
  const byDn = (dn) => [...users.values()].find((user) => user.dn === dn);
  const factory = () => ({
    async bind(dn, given) {
      if (state.down) throw new Error('connect ECONNREFUSED');
      if (dn === BIND_DN) return;
      state.userBinds += 1;
      const user = byDn(dn);
      if (!user || user.badPwdCount >= 3 || !Object.is(user.password, given)) {
        if (user) user.badPwdCount += 1;
        throw new InvalidCredentialsError('invalid credentials');
      }
      user.badPwdCount = 0;
    },
    async search(base, options) {
      if (options.scope === 'base') {
        const user = byDn(base);
        const group = options.filter.slice(options.filter.indexOf(':=') + 2, -1);
        return { searchEntries: user?.groups.map(escapeFilterValue).includes(group) ? [{ dn: base }] : [] };
      }
      const name = options.filter.match(/sAMAccountName=([^)]*)\)/)[1];
      const user = users.get(name.toLowerCase());
      return {
        searchEntries: user ? [{
          dn: user.dn, objectGUID: user.guid, sAMAccountName: user.username, mail: user.mail,
          displayName: user.displayName, department: user.department, userAccountControl: user.disabled ? '514' : '512',
          accountExpires: '0',
        }] : [],
      };
    },
    async unbind() {},
  });

  return {
    state,
    factory,
    add(username, { department, groups = [ALLOWED], mail = `${username}@empresa.test` } = {}) {
      const user = {
        username, mail, department, groups, password: PASSWORD, badPwdCount: 0, disabled: false,
        dn: `CN=${username},CN=Users,DC=empresa,DC=test`, displayName: `AD ${username}`, guid: randomBytes(16),
      };
      users.set(username.toLowerCase(), user);
      return user;
    },
    rename(oldName, newName) {
      const user = users.get(oldName.toLowerCase());
      users.delete(oldName.toLowerCase());
      user.username = newName;
      users.set(newName.toLowerCase(), user);
    },
  };
}
