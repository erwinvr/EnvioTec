import { Client, InvalidCredentialsError } from 'ldapts';
import { ServiceUnavailableError } from '../../errors/errors.js';
import { escapeFilterValue, firstValue, guidToUuid, isAccountDisabled, isAccountExpired } from './ldap-utils.js';

// Active Directory provider over LDAPS only (ADR-006): certificate validated
// against the internal CA, read-only service account for searches, bind with
// the user's own DN to check the password, escaped filters, empty passwords
// rejected before contacting AD, nested group membership through
// LDAP_MATCHING_RULE_IN_CHAIN.

const IN_CHAIN = '1.2.840.113556.1.4.1941';
const ATTRIBUTES = ['objectGUID', 'sAMAccountName', 'mail', 'displayName', 'department', 'userAccountControl',
  'accountExpires'];

function defaultClientFactory(config) {
  return () => new Client({
    url: config.url,
    timeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
    strictDN: true,
    tlsOptions: { ca: [config.caCert], minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
}

export function createAdProvider(config, { clientFactory = defaultClientFactory(config), logger } = {}) {
  if (!config.enabled) return { enabled: false };

  async function withServiceClient(fn) {
    const client = clientFactory();
    try {
      await client.bind(config.bindDn, config.bindPassword);
      return await fn(client);
    } catch (error) {
      throw unavailable(error);
    } finally {
      await client.unbind().catch(() => {});
    }
  }

  function unavailable(error) {
    if (error instanceof ServiceUnavailableError) return error;
    logger?.error({ errorName: error?.name, errorMessage: error?.message }, 'active directory unavailable');
    return new ServiceUnavailableError('El directorio no está disponible; intente más tarde');
  }

  async function findEntry(client, username) {
    const { searchEntries } = await client.search(config.baseDn, {
      scope: 'sub',
      filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${escapeFilterValue(username)}))`,
      attributes: ATTRIBUTES,
      explicitBufferAttributes: ['objectGUID'],
      sizeLimit: 2,
    });
    return searchEntries.length === 1 ? toEntry(searchEntries[0]) : null;
  }

  async function groupsOf(client, dn, groupDns) {
    const member = new Set();
    for (const groupDn of groupDns) {
      const { searchEntries } = await client.search(dn, {
        scope: 'base',
        filter: `(memberOf:${IN_CHAIN}:=${escapeFilterValue(groupDn)})`,
        attributes: ['distinguishedName'],
        sizeLimit: 1,
      });
      if (searchEntries.length > 0) member.add(groupDn);
    }
    return member;
  }

  return {
    enabled: true,

    // Checks the password. Returns { status: 'ok', entry } or
    // { status: 'invalid' } (unknown user or wrong password). Throws
    // ServiceUnavailableError when AD cannot be reached, which never counts
    // as a failed attempt.
    async authenticate(username, password) {
      if (typeof password !== 'string' || password.length === 0) return { status: 'invalid' };
      const entry = await withServiceClient((client) => findEntry(client, username));
      if (!entry) return { status: 'invalid' };

      const userClient = clientFactory();
      try {
        await userClient.bind(entry.dn, password);
      } catch (error) {
        if (error instanceof InvalidCredentialsError) return { status: 'invalid' };
        throw unavailable(error);
      } finally {
        await userClient.unbind().catch(() => {});
      }
      return { status: 'ok', entry };
    },

    // Current state of an account without its password (re-checks and the
    // periodic review in phase 5).
    async lookup(username) {
      return withServiceClient((client) => findEntry(client, username));
    },

    // Whether the account may use EnvioTec, and which of the mapped groups
    // (role mappings) it belongs to, nested groups included.
    async evaluate(entry, mappedGroupDns = []) {
      if (entry.disabled) return { allowed: false, reason: 'ad_account_disabled', groups: new Set() };
      if (entry.expired) return { allowed: false, reason: 'ad_account_expired', groups: new Set() };
      const groups = await withServiceClient((client) => groupsOf(client, entry.dn, [config.allowedGroupDn, ...mappedGroupDns]));
      if (!groups.has(config.allowedGroupDn)) return { allowed: false, reason: 'ad_not_in_group', groups: new Set() };
      groups.delete(config.allowedGroupDn);
      return { allowed: true, groups };
    },
  };
}

function toEntry(raw) {
  return {
    dn: raw.dn,
    objectGuid: guidToUuid(Array.isArray(raw.objectGUID) ? raw.objectGUID[0] : raw.objectGUID),
    username: firstValue(raw.sAMAccountName),
    email: firstValue(raw.mail),
    displayName: firstValue(raw.displayName),
    department: firstValue(raw.department),
    disabled: isAccountDisabled(firstValue(raw.userAccountControl)),
    expired: isAccountExpired(firstValue(raw.accountExpires)),
  };
}
