// SQL for MFA: TOTP secret, recovery codes and enrollment codes (ADR-006).

export function createMfaRepository() {
  return {
    // Accepts a TOTP step only if it is newer than the last one used, so a
    // code cannot be replayed (not even within its 30 seconds).
    async consumeTotpStep(db, userId, step) {
      const { rowCount } = await db.query(
        `UPDATE users SET mfa_last_used_step = $2
          WHERE id = $1 AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $2)`,
        [userId, step],
      );
      return rowCount === 1;
    },

    async consumeRecoveryCode(db, userId, codeHash) {
      const { rowCount } = await db.query(
        `UPDATE mfa_recovery_codes SET used_at = now()
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [userId, codeHash],
      );
      return rowCount === 1;
    },

    async enableMfa(db, userId, encryptedSecret, step) {
      const { rowCount } = await db.query(
        `UPDATE users SET mfa_secret_encrypted = $2, mfa_enabled_at = now(), mfa_last_used_step = $3
          WHERE id = $1 AND mfa_enabled_at IS NULL`,
        [userId, encryptedSecret, step],
      );
      return rowCount === 1;
    },

    async replaceRecoveryCodes(db, userId, codeHashes) {
      await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
      await db.query(
        'INSERT INTO mfa_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::bytea[])',
        [userId, codeHashes],
      );
    },

    async disableMfa(db, userId, actorId) {
      await db.query(
        `UPDATE users SET mfa_secret_encrypted = NULL, mfa_enabled_at = NULL, mfa_last_used_step = NULL, updated_by = $2
          WHERE id = $1`,
        [userId, actorId],
      );
      await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    },

    async findValidEnrollmentCode(db, userId, codeHash, maxAttempts) {
      const { rows } = await db.query(
        `SELECT id FROM mfa_enrollment_codes
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > now() AND failed_attempts < $3`,
        [userId, codeHash, maxAttempts],
      );
      return rows[0]?.id ?? null;
    },

    async addEnrollmentFailure(db, userId) {
      await db.query(
        `UPDATE mfa_enrollment_codes SET failed_attempts = failed_attempts + 1
          WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
        [userId],
      );
    },

    async useEnrollmentCode(db, codeId, maxAttempts) {
      const { rowCount } = await db.query(
        `UPDATE mfa_enrollment_codes SET used_at = now()
          WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND failed_attempts < $2`,
        [codeId, maxAttempts],
      );
      return rowCount === 1;
    },

    // A new code (or a reset) invalidates any previous unused one.
    async expireEnrollmentCodes(db, userId) {
      await db.query(
        'UPDATE mfa_enrollment_codes SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()',
        [userId],
      );
    },

    async createEnrollmentCode(db, { userId, codeHash, issuedBy, validityHours }) {
      const { rows } = await db.query(
        `INSERT INTO mfa_enrollment_codes (user_id, code_hash, issued_by, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4))
         RETURNING id, expires_at`,
        [userId, codeHash, issuedBy, validityHours],
      );
      return rows[0];
    },
  };
}
