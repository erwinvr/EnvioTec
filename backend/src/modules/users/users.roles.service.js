import { actorFrom } from '../../core/audit/audit.service.js';
import { createSessionRepository } from '../../core/auth/session.repository.js';
import { areaScopeFor } from '../../core/authorization/area-scope.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { NotFoundError } from '../../core/errors/errors.js';
import { assertKeepsASuperadmin, checkRoleChange } from './users.rules.js';
import { toUser } from './users.service.js';

// Role assignment (A6): replaces the user's manual roles with the requested
// set, applying the anti-escalation rules of users.rules.js. Roles that come
// from AD groups are kept. Every change revokes the user's sessions (rule 6).
export function createUserRolesService({ db, repository, audit }) {
  function apply(auth, id, roleIds, context) {
    return withTransaction(db, async (client) => {
      const target = await repository.findInScope(client, areaScopeFor(auth), id, { forUpdate: true });
      if (!target) throw new NotFoundError();

      const requestedIds = [...new Set(roleIds)];
      const currentIds = target.roles.map((role) => role.id);
      const roles = await repository.findRoles(client, [...new Set([...requestedIds, ...currentIds])]);
      const rolesById = new Map(roles.map((role) => [role.id, role]));
      const { added, removed } = checkRoleChange({
        actor: { id: auth.user.id, permissions: auth.permissions }, target, currentRoles: target.roles, requestedIds, rolesById,
      });
      if (added.length === 0 && removed.length === 0) return toUser(target);

      if (removed.some((roleId) => rolesById.get(roleId).name === 'superadmin')) {
        assertKeepsASuperadmin({
          targetIsSuperadmin: true, targetIsEmergency: target.is_emergency, losesRole: true,
          otherActiveSuperadmins: await repository.countOtherActiveSuperadmins(client, id),
        });
      }

      await repository.replaceManualRoles(client, id, requestedIds, auth.user.id);
      const revoked = await createSessionRepository(client).revokeAllForUser(id, 'roles_changed');
      const name = (roleId) => rolesById.get(roleId).name;
      await audit.record(client, {
        actor: actorFrom(auth), action: 'user.roles_update', resourceType: 'user', resourceId: id, result: 'success',
        context, metadata: { added: added.map(name), removed: removed.map(name), revokedSessions: revoked },
      });
      return toUser(await repository.findInScope(client, { all: true }, id));
    });
  }

  return {
    async replace(auth, id, roleIds, context) {
      assertRecentReauth(auth);
      try {
        return await apply(auth, id, roleIds, context);
      } catch (error) {
        // A7: every 403 is audited. The transaction was rolled back, so the
        // attempt is recorded on its own.
        if (error.code === 'PRIVILEGE_ESCALATION') {
          await audit.record(db, {
            actor: actorFrom(auth), action: 'user.roles_update', resourceType: 'user', resourceId: id, result: 'denied',
            context, metadata: { reason: 'privilege_escalation', requestedRoleIds: roleIds },
          });
        }
        throw error;
      }
    },
  };
}
