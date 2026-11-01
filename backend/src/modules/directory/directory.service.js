import { actorFrom } from '../../core/audit/audit.service.js';
import { withTransaction } from '../../core/db/transaction.js';
import { NotFoundError, ValidationError } from '../../core/errors/errors.js';
import { isValidDn } from './dn.js';

// AD group to role mappings (ADR-007): only business roles; with AD enabled
// the group must exist in the directory. Changes apply at the next login or
// AD review (at most 15 minutes).

const toMapping = (row) => ({ id: row.id, groupDn: row.group_dn, roleId: row.role_id, roleName: row.role_name });

export function createDirectoryService({ db, repository, ad, audit }) {
  const record = (client, auth, context, action, id, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'ad_group_mapping', resourceId: id, result: 'success', context, metadata,
  });

  return {
    async list() {
      return (await repository.list(db)).map(toMapping);
    },

    async create(auth, { groupDn, roleId }, context) {
      const dn = groupDn.trim();
      if (!isValidDn(dn)) throw new ValidationError([{ field: 'groupDn', code: 'invalid_dn' }]);
      const role = await repository.findRole(db, roleId);
      if (!role) throw new ValidationError([{ field: 'roleId', code: 'unknown_role' }]);
      if (role.administrative) {
        throw new ValidationError([{ field: 'roleId', code: 'administrative_role' }], 'Un grupo de AD solo puede dar roles de negocio');
      }
      if (ad.enabled && !await ad.groupExists(dn)) {
        throw new ValidationError([{ field: 'groupDn', code: 'group_not_found' }], 'El grupo no existe en el directorio');
      }
      return withTransaction(db, async (client) => {
        const id = await repository.create(client, { groupDn: dn, roleId, actorId: auth.user.id });
        await record(client, auth, context, 'directory.mapping_create', id, { groupDn: dn, role: role.name });
        return { id, groupDn: dn, roleId, roleName: role.name };
      });
    },

    async remove(auth, id, context) {
      await withTransaction(db, async (client) => {
        const removed = await repository.delete(client, id);
        if (!removed) throw new NotFoundError();
        await record(client, auth, context, 'directory.mapping_delete', id, { groupDn: removed.group_dn, roleId: removed.role_id });
      });
    },
  };
}
