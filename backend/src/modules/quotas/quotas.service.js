import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor } from '../../core/authorization/area-scope.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { ConflictError, NotFoundError } from '../../core/errors/errors.js';
import { adjusted, assertWithinCap, available, consumed, refunded, released, reserved } from './quotas.rules.js';

// Send quotas (Parte B, ADR-011). Without areas.view_all a user sees only
// their own quota; administrators adjust with quotas.manage, a reason and a
// recent reauthentication, never their own. Every change locks the row,
// writes an append-only movement and is audited in the same transaction.
// reserve / release / consume are the building blocks for campaigns (8.4).

const MAX_OFFSET = 10000;

const toQuota = (q) => ({ assigned: q.assigned, reserved: q.reserved, consumed: q.consumed, available: available(q) });
const toMovement = (m) => ({
  id: m.id, kind: m.kind, amount: m.amount, assignedAfter: m.assigned_after, reservedAfter: m.reserved_after,
  consumedAfter: m.consumed_after, campaignId: m.campaign_id, reason: m.reason, actorUsername: m.actor_username,
  occurredAt: m.occurred_at.toISOString(),
});

export function createQuotasService({ db, repository, audit }) {
  const sees = (auth, userId) => auth.permissions.has('areas.view_all') || auth.user.id === userId;

  // Applies a change to a user's quota inside the caller's transaction.
  async function apply(client, { userId, kind, amount, change, campaignId, reason, actor, context }) {
    const before = await repository.lock(client, userId);
    const after = change(before);
    await repository.save(client, userId, after);
    await repository.addMovement(client, { userId, kind, amount, quota: after, campaignId, reason, actorId: actor?.userId ?? null });
    await audit.record(client, {
      actor: actor ?? { type: 'system' }, action: `quota.${kind}`, resourceType: 'quota', resourceId: userId, result: 'success',
      context, metadata: { amount, campaignId: campaignId ?? null, reason: reason ?? null, before: toQuota(before), after: toQuota(after) },
    });
    return after;
  }

  return {
    async mine(auth, paging) {
      return this.detail(auth, auth.user.id, paging);
    },

    async detail(auth, userId, { page, pageSize }) {
      if (!sees(auth, userId)) throw new NotFoundError();
      if (!await repository.findUserInScope(db, areaScopeFor(auth), userId)) throw new NotFoundError();
      const quota = await repository.find(db, userId);
      const { rows, total } = await repository.movements(db, userId, { limit: pageSize, offset: (page - 1) * pageSize });
      return { quota: toQuota(quota), movements: rows.map(toMovement), total };
    },

    async list(auth, { search, page, pageSize }) {
      if (!auth.permissions.has('areas.view_all')) {
        const own = await repository.find(db, auth.user.id);
        return { items: [{ userId: auth.user.id, username: auth.user.username, displayName: auth.user.displayName, areaName: null, ...toQuota(own) }], total: 1 };
      }
      const offset = (page - 1) * pageSize;
      if (offset > MAX_OFFSET) throw new ConflictError('Página demasiado lejana');
      const { rows, total } = await repository.list(db, areaScopeFor(auth), { search, limit: pageSize, offset });
      return {
        total,
        items: rows.map((row) => ({ userId: row.id, username: row.username, displayName: row.display_name, areaName: row.area_name, ...toQuota(row) })),
      };
    },

    async adjust(auth, userId, { delta, reason }, context) {
      assertRecentReauth(auth);
      if (auth.user.id === userId) throw new ConflictError('Nadie ajusta su propio saldo');
      if (!await repository.findUserInScope(db, areaScopeFor(auth), userId)) throw new NotFoundError();
      return withTransaction(db, async (client) => toQuota(await apply(client, {
        userId, kind: 'adjust', amount: delta, change: (q) => adjusted(q, delta), reason, actor: actorFrom(auth), context,
      })));
    },

    async globalUsage() {
      const [usage, cap] = await Promise.all([repository.currentMonth(db), repository.monthlyCap(db)]);
      return { month: usage.month, sent: usage.sent, cap, remaining: Math.max(0, cap - usage.sent) };
    },

    // --- Building blocks for campaigns (8.4); they run in the caller's transaction.

    reserve(client, { userId, amount, campaignId, actor, context }) {
      return apply(client, { userId, kind: 'reserve', amount, change: (q) => reserved(q, amount), campaignId, actor, context });
    },

    release(client, { userId, amount, campaignId, actor, context }) {
      return apply(client, { userId, kind: 'release', amount, change: (q) => released(q, amount), campaignId, actor, context });
    },

    // Checks and updates the global monthly cap (row lock) before consuming.
    async consume(client, { userId, amount, campaignId, fromReserve = true, actor, context }) {
      const month = await repository.lockMonth(client);
      assertWithinCap(month.sent, amount, await repository.monthlyCap(client));
      const after = await apply(client, {
        userId, kind: 'consume', amount, change: (q) => consumed(q, amount, { fromReserve }), campaignId, actor, context,
      });
      await repository.addToMonth(client, month.month, amount);
      return after;
    },

    // Gives back what Mandrill did not accept, in the quota and in the month.
    async refund(client, { userId, amount, campaignId, toReserve = true, actor, context }) {
      const month = await repository.lockMonth(client);
      const after = await apply(client, {
        userId, kind: 'refund', amount, change: (q) => refunded(q, amount, { toReserve }), campaignId, actor, context,
      });
      await repository.addToMonth(client, month.month, -Math.min(amount, month.sent));
      return after;
    },
  };
}
