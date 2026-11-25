import { createAuditService } from '../../../backend/src/core/audit/audit.service.js';

// Mass revocation of sessions (runbook, incident response): every active
// session, or only those of one user, revoked in one audited transaction.
export async function revokeSessions(client, { reason, userId = null }) {
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 100) {
    throw new Error('el motivo es obligatorio (5 a 100 caracteres)');
  }
  const { rowCount } = await client.query(
    `UPDATE sessions SET revoked_at = SYSUTCDATETIME(), revoked_reason = 'mass_revocation'
      WHERE revoked_at IS NULL AND expires_at > SYSUTCDATETIME() AND ($1 IS NULL OR user_id = $1)`,
    [userId],
  );
  await createAuditService().record(client, {
    actor: { type: 'system' }, action: 'session.mass_revoke', resourceType: 'sessions', resourceId: userId, result: 'success',
    metadata: { sessions: rowCount, reason: reason.trim() },
  });
  return { sessions: rowCount };
}
