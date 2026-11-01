// Applies what AD says about an account (ADR-006): display data, area by
// department and the roles of the mapped groups. Shared by the login and by
// the periodic AD review of the worker. Returns whether the roles changed.
export function createAdSync({ repository, audit }) {
  return {
    async apply(client, userId, entry, groups, mappings, context) {
      const areaId = await repository.findAreaByDepartment(client, entry.department);
      await repository.updateAdUser(client, userId, entry, areaId);
      const roleIds = mappings.filter((mapping) => groups.has(mapping.group_dn)).map((mapping) => mapping.role_id);
      const changed = await repository.syncAdRoles(client, userId, roleIds);
      if (changed) {
        await audit.record(client, {
          actor: { type: 'system' }, action: 'user.roles_sync', resourceType: 'user', resourceId: userId,
          result: 'success', context, metadata: { source: 'ad_group', roleIds },
        });
      }
      return { rolesChanged: changed };
    },
  };
}
