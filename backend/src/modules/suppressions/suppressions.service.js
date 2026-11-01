import { actorFrom } from '../../core/audit/audit.service.js';
import { hasPermission, assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { ConflictError, NotFoundError } from '../../core/errors/errors.js';
import { maskEmail } from '../../core/privacy/mask.js';

// Global suppression list (Parte B): unsubscribes, hard bounces, complaints
// and anonymizations are excluded from every send, with no exception by role
// and for the whole organization. Only manual entries can be removed (also
// enforced by a trigger). Profiles without contacts.view see masked emails.

export function createSuppressionsService({ db, repository, audit }) {
  const record = (client, auth, context, action, id, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'suppression', resourceId: id, result: 'success', context, metadata,
  });

  return {
    async list(request, { search, page, pageSize }) {
      const unmasked = hasPermission(request, 'contacts.view');
      const { rows, total } = await repository.list(db, { search, limit: pageSize, offset: (page - 1) * pageSize });
      return {
        total,
        items: rows.map((row) => ({
          id: row.id, email: row.email === null ? null : (unmasked ? row.email : maskEmail(row.email)), emailHash: row.email_hash,
          reason: row.reason, source: row.source, note: row.note, createdBy: row.created_by_username, createdAt: row.created_at.toISOString(),
        })),
      };
    },

    async add(auth, { email, note }, context) {
      return withTransaction(db, async (client) => {
        const id = await repository.add(client, { email, reason: 'manual', source: 'manual', note, actorId: auth.user.id });
        if (!id) throw new ConflictError('El email ya está en la lista de supresión');
        await record(client, auth, context, 'suppression.add', id, { reason: 'manual' });
        return { id };
      });
    },

    async remove(auth, id, context) {
      await withTransaction(db, async (client) => {
        const row = await repository.find(client, id);
        if (!row) throw new NotFoundError();
        if (row.reason !== 'manual') throw new ConflictError('Solo se quitan las supresiones manuales');
        await repository.remove(client, id);
        await record(client, auth, context, 'suppression.remove', id, { reason: row.reason });
      });
    },

    // Reauthentication: irreversible and affects every area.
    async anonymize(auth, { email }, context) {
      assertRecentReauth(auth);
      return withTransaction(db, async (client) => {
        const result = await repository.anonymize(client, email.toLowerCase());
        // Never the email in the audit: only its hash.
        await record(client, auth, context, 'contact.anonymize', result.emailHash, { contacts: result.contacts, emailHash: result.emailHash });
        return result;
      });
    },
  };
}
