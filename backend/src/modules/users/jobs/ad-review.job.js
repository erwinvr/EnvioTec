import { createSessionRepository } from '../../../core/auth/session.repository.js';
import { withTransaction } from '../../../core/db/transaction.js';
import { createAdSync } from '../../auth/ad-sync.js';

// Review of AD accounts every 15 minutes (Parte B): an account disabled or
// expired in AD, outside the enabled group, or no longer found loses its
// sessions within 15 minutes; area and group roles follow AD, and a role
// change revokes the sessions too (A6 rule 6). If AD cannot be reached the
// round stops and is retried on the next one.

const BATCH = 100;
const CONTEXT = { requestId: 'job:ad-review' };

export function createAdReviewJob({ pool, repository, authRepository, ad, audit, logger }) {
  const adSync = createAdSync({ repository: authRepository, audit });

  async function revoke(user, reason) {
    return withTransaction(pool, async (client) => {
      const revoked = await createSessionRepository(client).revokeAllForUser(user.id, reason);
      // Audited only when something changed, so a long-disabled account does
      // not add an event every 15 minutes.
      if (revoked > 0) {
        await audit.record(client, {
          actor: { type: 'system' }, action: 'user.ad_review', resourceType: 'user', resourceId: user.id, result: 'denied',
          context: CONTEXT, metadata: { reason, revokedSessions: revoked },
        });
      }
      return revoked;
    });
  }

  return async function run() {
    if (!ad.enabled) return { skipped: 'ad_disabled' };
    const mappings = await authRepository.listAdGroupMappings(pool);
    const mappedDns = mappings.map((mapping) => mapping.group_dn);
    const summary = { reviewed: 0, revoked: 0, synced: 0, errors: 0 };

    let afterId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const users = await repository.listActiveAdUsers(pool, afterId, BATCH);
      if (users.length === 0) break;
      for (const user of users) {
        summary.reviewed += 1;
        const entry = await ad.lookup(user.username);
        if (!entry || entry.objectGuid !== user.ad_object_guid) {
          summary.revoked += await revoke(user, 'ad_account_not_found');
          continue;
        }
        const access = await ad.evaluate(entry, mappedDns);
        if (!access.allowed) {
          summary.revoked += await revoke(user, access.reason);
          continue;
        }
        try {
          await withTransaction(pool, async (client) => {
            const { rolesChanged } = await adSync.apply(client, user.id, entry, access.groups, mappings, CONTEXT);
            if (rolesChanged) {
              summary.synced += 1;
              summary.revoked += await createSessionRepository(client).revokeAllForUser(user.id, 'roles_changed');
            }
          });
        } catch (error) {
          // One account with conflicting data (for example an email taken by
          // another account) must not stop the review of the rest.
          summary.errors += 1;
          logger.error({ userId: user.id, errorCode: error.code }, 'ad review: account could not be synchronized');
        }
      }
      afterId = users.at(-1).id;
    }
    return summary;
  };
}
