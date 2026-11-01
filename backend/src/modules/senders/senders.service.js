import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor } from '../../core/authorization/area-scope.js';
import { hasPermission } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { NotFoundError, ValidationError } from '../../core/errors/errors.js';
import { assertSenderDomains } from './senders.rules.js';

// Senders per area (Parte B). Campaign users see the active senders of their
// area; administrators (senders.manage) also the inactive ones. The email is
// fixed once created: campaigns reference the identity, so a different
// address is a new sender.

const toSender = (row) => ({
  id: row.id, areaId: row.area_id, areaName: row.area_name, email: row.email, displayName: row.display_name,
  replyTo: row.reply_to, isActive: row.is_active,
});
const snapshot = (row) => ({ displayName: row.display_name, replyTo: row.reply_to, isActive: row.is_active });

export function createSendersService({ db, repository, audit }) {
  return {
    async list(request) {
      const rows = await repository.list(db, areaScopeFor(request.auth), { activeOnly: !hasPermission(request, 'senders.manage') });
      return rows.map(toSender);
    },

    async create(auth, input, context) {
      const scope = areaScopeFor(auth);
      return withTransaction(db, async (client) => {
        const area = await repository.findArea(client, input.areaId);
        if (!area || !area.is_active || (!scope.all && scope.areaId !== input.areaId)) {
          throw new ValidationError([{ field: 'areaId', code: 'invalid_area' }]);
        }
        assertSenderDomains(input, await repository.domains(client));
        const id = await repository.create(client, { ...input, actorId: auth.user.id });
        const row = await repository.findInScope(client, { all: true }, id);
        await audit.record(client, {
          actor: actorFrom(auth), action: 'sender.create', resourceType: 'sender', resourceId: id, result: 'success', context,
          metadata: { areaId: input.areaId, email: row.email, ...snapshot(row) },
        });
        return toSender(row);
      });
    },

    async update(auth, id, changes, context) {
      return withTransaction(db, async (client) => {
        const before = await repository.findInScope(client, areaScopeFor(auth), id, { forUpdate: true });
        if (!before) throw new NotFoundError();
        if ('replyTo' in changes) assertSenderDomains({ replyTo: changes.replyTo }, await repository.domains(client));
        await repository.update(client, id, changes, auth.user.id);
        const after = await repository.findInScope(client, { all: true }, id);
        await audit.record(client, {
          actor: actorFrom(auth), action: 'sender.update', resourceType: 'sender', resourceId: id, result: 'success', context,
          metadata: { before: snapshot(before), after: snapshot(after) },
        });
        return toSender(after);
      });
    },
  };
}
