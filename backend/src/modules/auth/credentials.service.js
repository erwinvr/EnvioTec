import { createSessionRepository } from '../../core/auth/session.repository.js';
import { withTransaction } from '../../core/db/transaction.js';

// Password checks shared by login, reauthentication and password change,
// with the lockout rules (A5, ADR-006):
//   local  from the threshold on, each failure doubles the lock (1, 2, 4...
//          minutes) up to the maximum; the counter restarts after 24 h
//          without failures
//   ad     the account is locked for LOCKOUT_AD_MIN after LOCKOUT_AD_THRESHOLD
//          failures, before AD reaches its own limit of 3
const LOCAL_FAILURE_RESET_MINUTES = 24 * 60;

export function lockMinutesFor(authSource, failures, lockout) {
  if (authSource === 'ad') return failures >= lockout.adThreshold ? lockout.adMinutes : 0;
  if (failures < lockout.localThreshold) return 0;
  return Math.min(2 ** (failures - lockout.localThreshold), lockout.localMaxMinutes);
}

export function createCredentialsService({ db, repository, audit, local, ad, lockout }) {
  async function registerFailure(user, context, action, reason) {
    await withTransaction(db, async (client) => {
      const resetWindow = user.auth_source === 'ad' ? lockout.adMinutes : LOCAL_FAILURE_RESET_MINUTES;
      const failures = await repository.registerFailure(client, user.id, resetWindow);
      const minutes = lockMinutesFor(user.auth_source, failures, lockout);
      await audit.record(client, {
        actor: context.actor ?? { type: 'anonymous' }, action, resourceType: 'user', resourceId: user.id,
        result: 'failure', context, metadata: { reason, failures },
      });
      if (minutes > 0) {
        const lockedUntil = await repository.lockUntil(client, user.id, minutes);
        await audit.record(client, {
          actor: { type: 'system' }, action: 'auth.lockout', resourceType: 'user', resourceId: user.id,
          result: 'success', context, metadata: { minutes, failures, lockedUntil: lockedUntil.toISOString() },
        });
      }
    });
  }

  return {
    // Returns { valid, needsRehash, adEntry }. A locked account is never
    // checked against its provider (for AD, so AD's own counter does not move).
    async checkPassword(user, password, context, action) {
      if (user.is_locked) {
        if (user.auth_source === 'local') await local.dummyVerify(password);
        await audit.record(db, {
          actor: context.actor ?? { type: 'anonymous' }, action, resourceType: 'user', resourceId: user.id,
          result: 'denied', context, metadata: { reason: 'locked' },
        });
        return { valid: false };
      }

      if (user.auth_source === 'local') {
        const { valid, needsRehash } = await local.verify(user.password_hash, password);
        if (!valid) await registerFailure(user, context, action, 'invalid_password');
        return { valid, needsRehash };
      }

      if (!ad.enabled) {
        await audit.record(db, {
          actor: context.actor ?? { type: 'anonymous' }, action, resourceType: 'user', resourceId: user.id,
          result: 'denied', context, metadata: { reason: 'ad_disabled' },
        });
        return { valid: false };
      }
      const result = await ad.authenticate(user.username, password);
      if (result.status !== 'ok') {
        await registerFailure(user, context, action, 'invalid_password');
        return { valid: false };
      }
      if (result.entry.objectGuid !== user.ad_object_guid) {
        // Same sAMAccountName, different AD object: never the same person.
        await audit.record(db, {
          actor: context.actor ?? { type: 'anonymous' }, action, resourceType: 'user', resourceId: user.id,
          result: 'denied', context, metadata: { reason: 'ad_guid_mismatch' },
        });
        return { valid: false };
      }
      return { valid: true, needsRehash: false, adEntry: result.entry };
    },

    // AD account state on every login and reauthentication (Parte B): a
    // disabled or expired account, or one outside the enabled group, loses
    // access and its sessions are revoked.
    async checkAdAccess(user, entry, mappedGroupDns, context, action) {
      const access = await ad.evaluate(entry, mappedGroupDns);
      if (access.allowed) return access;
      await withTransaction(db, async (client) => {
        const revoked = await createSessionRepository(client).revokeAllForUser(user.id, access.reason);
        await audit.record(client, {
          actor: context.actor ?? { type: 'anonymous' }, action, resourceType: 'user', resourceId: user.id,
          result: 'denied', context, metadata: { reason: access.reason, revokedSessions: revoked },
        });
      });
      return access;
    },
  };
}
