// Mass revocation of sessions (runbook, incident response): every active
// session, or only those of one user, revoked in one audited transaction.
export async function revokeSessions(client, { reason, userId = null }) {
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 100) {
    throw new Error('el motivo es obligatorio (5 a 100 caracteres)');
  }
  const { rowCount } = await client.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'mass_revocation'
      WHERE revoked_at IS NULL AND expires_at > now() AND ($1::uuid IS NULL OR user_id = $1)`,
    [userId],
  );
  await client.query(
    "SELECT append_audit_log('system', NULL, NULL, 'session.mass_revoke', 'sessions', $1, 'success', NULL, NULL, NULL, jsonb_build_object('sessions', $2::int, 'reason', $3::text))",
    [userId, rowCount, reason.trim()],
  );
  return { sessions: rowCount };
}
