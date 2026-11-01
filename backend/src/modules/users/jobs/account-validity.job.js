import { createSessionRepository } from '../../../core/auth/session.repository.js';
import { withTransaction } from '../../../core/db/transaction.js';

// Daily control of local accounts (Parte B): disables expired and inactive
// accounts and revokes their sessions, and warns before the expiry, by mail
// to the account and to notifications.admin_emails. Runs hourly; every step
// is idempotent.

const SYSTEM = { type: 'system' };
const CONTEXT = { requestId: 'job:account-validity' };

export function createAccountValidityJob({ pool, repository, audit, mailer, logger }) {
  async function disableAll(client, rows, reason) {
    for (const row of rows) {
      const revoked = await createSessionRepository(client).revokeAllForUser(row.id, `account_${reason}`);
      await audit.record(client, {
        actor: SYSTEM, action: 'user.disable', resourceType: 'user', resourceId: row.id, result: 'success',
        context: CONTEXT, metadata: { reason, revokedSessions: revoked },
      });
    }
  }

  function sendWarnings(warnings, adminEmails) {
    for (const user of warnings) {
      const date = user.expires_at.toISOString().slice(0, 10);
      const text = [
        `La cuenta de EnvioTec "${user.username}" (${user.display_name}) vence el ${date}.`,
        'Para renovarla, un administrador debe registrar la renovación con su motivo.',
        '',
        `The EnvioTec account "${user.username}" expires on ${date}.`,
      ].join('\n');
      for (const to of [user.email, ...adminEmails]) {
        mailer.send({ to, tag: 'account-expiry-warning', subject: `EnvioTec: la cuenta ${user.username} vence el ${date}`, text })
          .catch((error) => logger.error({ errorMessage: error.message, userId: user.id }, 'expiry warning mail failed'));
      }
    }
  }

  return async function run() {
    const settings = await repository.getSettings(pool, [
      'local_account.inactivity_disable_days', 'local_account.expiry_warning_days', 'notifications.admin_emails',
    ]);
    const result = await withTransaction(pool, async (client) => {
      const expired = await repository.disableExpired(client);
      await disableAll(client, expired, 'expired');
      const inactive = await repository.disableInactive(client, settings['local_account.inactivity_disable_days']);
      await disableAll(client, inactive, 'inactive');
      const warnings = await repository.claimExpiryWarnings(client, settings['local_account.expiry_warning_days']);
      for (const user of warnings) {
        await audit.record(client, {
          actor: SYSTEM, action: 'user.expiry_warning', resourceType: 'user', resourceId: user.id, result: 'success',
          context: CONTEXT, metadata: { expiresAt: user.expires_at.toISOString() },
        });
      }
      return { expired, inactive, warnings };
    });
    // Mail goes out only after the transaction committed.
    sendWarnings(result.warnings, settings['notifications.admin_emails'] ?? []);
    return { expired: result.expired.length, inactive: result.inactive.length, warned: result.warnings.length };
  };
}
