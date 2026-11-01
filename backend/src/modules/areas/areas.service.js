import { actorFrom } from '../../core/audit/audit.service.js';
import { hasPermission } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { NotFoundError } from '../../core/errors/errors.js';

// Areas (ADR-008). They are never deleted: business data keeps pointing to
// them; an inactive area just stops receiving AD users by department.

function toArea(row, { withDirectory }) {
  const area = { id: row.id, name: row.name, isActive: row.is_active };
  if (withDirectory) area.adDepartment = row.ad_department;
  return area;
}

const snapshot = (row) => ({ name: row.name, adDepartment: row.ad_department, isActive: row.is_active });

export function createAreasService({ db, repository, audit }) {
  return {
    // Every signed-in user sees the area names (for forms and filters); the
    // AD department mapping only those who manage areas.
    async list(request) {
      const withDirectory = hasPermission(request, 'areas.manage');
      return (await repository.list(db)).map((row) => toArea(row, { withDirectory }));
    },

    async create(auth, input, context) {
      return withTransaction(db, async (client) => {
        const row = await repository.create(client, { ...input, actorId: auth.user.id });
        await audit.record(client, {
          actor: actorFrom(auth), action: 'area.create', resourceType: 'area', resourceId: row.id, result: 'success',
          context, metadata: { after: snapshot(row) },
        });
        return toArea(row, { withDirectory: true });
      });
    },

    async update(auth, id, changes, context) {
      return withTransaction(db, async (client) => {
        const before = await repository.findById(client, id, { forUpdate: true });
        if (!before) throw new NotFoundError();
        const after = await repository.update(client, id, changes, auth.user.id);
        await audit.record(client, {
          actor: actorFrom(auth), action: 'area.update', resourceType: 'area', resourceId: id, result: 'success',
          context, metadata: { before: snapshot(before), after: snapshot(after) },
        });
        return toArea(after, { withDirectory: true });
      });
    },
  };
}
