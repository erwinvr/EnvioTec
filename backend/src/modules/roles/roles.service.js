import { actorFrom } from '../../core/audit/audit.service.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { NotFoundError } from '../../core/errors/errors.js';
import { PERMISSION_CATALOG } from '../permission-catalog.js';
import {
  assertDeletable, assertRenamable, checkNewRole, checkPermissionChange,
} from './roles.rules.js';

// Roles (A6). Changing the permissions of a role revokes the sessions of its
// users (rule 6, approved for phase 6) and is audited before/after. A 403 for
// privilege escalation is audited even though its transaction rolls back.

const CATALOG = new Map(PERMISSION_CATALOG.map((p) => [p.code, { administrative: p.administrative }]));

function toRole(row, mappings) {
  const role = {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    administrative: row.permissions.some((code) => CATALOG.get(code)?.administrative),
    usedFromAd: row.used_from_ad,
    userCount: row.user_count,
    permissions: row.permissions,
  };
  if (mappings) role.adGroups = mappings.map((m) => ({ id: m.id, groupDn: m.group_dn }));
  return role;
}

const asRule = (row) => ({
  id: row.id, name: row.name, isSystem: row.is_system, usedFromAd: row.used_from_ad,
  userCount: row.user_count, mappingCount: row.mapping_count,
});

export function createRolesService({ db, repository, audit }) {
  const record = (client, auth, context, action, id, result, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'role', resourceId: id, result, context, metadata,
  });

  async function load(client, id, options) {
    const row = await repository.findById(client, id, options);
    if (!row) throw new NotFoundError();
    return row;
  }

  // Runs fn; if it fails for privilege escalation, records the denied attempt.
  async function auditingDenial(auth, context, action, id, metadata, fn) {
    try {
      return await fn();
    } catch (error) {
      if (error.code === 'PRIVILEGE_ESCALATION') await record(db, auth, context, action, id ?? null, 'denied', metadata);
      throw error;
    }
  }

  return {
    async list() {
      return (await repository.list(db)).map((row) => toRole(row));
    },

    async get(id) {
      const row = await load(db, id);
      return toRole(row, await repository.listMappings(db, id));
    },

    async create(auth, { name, description, permissions = [] }, context) {
      if (permissions.length > 0) assertRecentReauth(auth);
      const codes = [...new Set(permissions)];
      return auditingDenial(auth, context, 'role.create', null, { name, permissions: codes }, () => {
        checkNewRole({ actorPermissions: auth.permissions, codes, catalog: CATALOG });
        return withTransaction(db, async (client) => {
          const id = await repository.create(client, { name, description, actorId: auth.user.id });
          await repository.setPermissions(client, id, codes, auth.user.id);
          await record(client, auth, context, 'role.create', id, 'success', { name, permissions: codes });
          return toRole(await load(client, id), []);
        });
      });
    },

    async update(auth, id, changes, context) {
      return withTransaction(db, async (client) => {
        const before = await load(client, id, { forUpdate: true });
        assertRenamable(asRule(before), changes);
        await repository.update(client, id, changes, auth.user.id);
        const after = await load(client, id);
        const fields = Object.keys(changes);
        await record(client, auth, context, 'role.update', id, 'success', {
          before: Object.fromEntries(fields.map((f) => [f, before[f]])),
          after: Object.fromEntries(fields.map((f) => [f, after[f]])),
        });
        return toRole(after, await repository.listMappings(client, id));
      });
    },

    async replacePermissions(auth, id, permissions, context) {
      assertRecentReauth(auth);
      const requestedCodes = [...new Set(permissions)];
      return auditingDenial(auth, context, 'role.permissions_update', id, { requested: requestedCodes }, () =>
        withTransaction(db, async (client) => {
          const role = await load(client, id, { forUpdate: true });
          const actor = { permissions: auth.permissions, roleIds: await repository.roleIdsOf(client, auth.user.id) };
          const { added, removed } = checkPermissionChange({
            actor, role: asRule(role), currentCodes: role.permissions, requestedCodes, catalog: CATALOG,
          });
          if (added.length === 0 && removed.length === 0) return toRole(role, await repository.listMappings(client, id));
          await repository.setPermissions(client, id, requestedCodes, auth.user.id);
          const revoked = await repository.revokeSessionsOfRole(client, id);
          await record(client, auth, context, 'role.permissions_update', id, 'success', {
            added, removed, before: role.permissions, revokedSessions: revoked,
          });
          return toRole(await load(client, id), await repository.listMappings(client, id));
        }));
    },

    async remove(auth, id, context) {
      assertRecentReauth(auth);
      await withTransaction(db, async (client) => {
        const role = await load(client, id, { forUpdate: true });
        assertDeletable(asRule(role));
        await repository.delete(client, id);
        await record(client, auth, context, 'role.delete', id, 'success', { name: role.name, permissions: role.permissions });
      });
    },
  };
}
