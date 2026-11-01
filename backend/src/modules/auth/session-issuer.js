import { createSessionRepository } from '../../core/auth/session.repository.js';
import { generateSessionToken, hashToken } from '../../core/auth/session-token.js';
import { computeStage } from '../../core/auth/stage.js';
import { AuthenticationError } from '../../core/errors/errors.js';
import { deriveCsrfToken } from '../../core/security/csrf.js';

// Creates and rotates sessions, and describes a session for the client
// (stage, CSRF token, user, permissions once fully authenticated).
export function createSessionIssuer({ db, config, mfaPolicy }) {
  const { absoluteTimeoutMin, idleTimeoutMin } = config.session;

  return {
    async issue(client, userId, context) {
      const token = generateSessionToken();
      const hash = hashToken(token);
      const row = await createSessionRepository(client).create({
        tokenHash: hash, userId, absoluteTimeoutMinutes: absoluteTimeoutMin, ip: context.ip, userAgent: context.userAgent,
      });
      return { token, hash, expiresAt: row.expires_at };
    },

    // New token for the same login (A5: after MFA and after privilege or
    // password changes); the old one stops working at once.
    async rotate(client, oldHash, { mfaVerified = false, reason = 'rotated' } = {}) {
      const token = generateSessionToken();
      const hash = hashToken(token);
      const row = await createSessionRepository(client).rotate(oldHash, hash, { mfaVerified, reason });
      if (!row) throw new AuthenticationError();
      return { token, hash, expiresAt: row.expires_at };
    },

    async describe(sessionHash) {
      const repository = createSessionRepository(db);
      const session = await repository.findValidSession(sessionHash, idleTimeoutMin);
      if (!session) throw new AuthenticationError();
      const permissions = await repository.findEffectivePermissions(session.user_id);
      const mfaRequired = mfaPolicy.isRequired(permissions);
      const stage = computeStage({
        mfaEnabled: session.mfa_enabled_at !== null,
        mfaVerified: session.mfa_verified_at !== null,
        mustChangePassword: session.must_change_password,
        mfaRequired,
      });
      return {
        stage,
        csrfToken: deriveCsrfToken(config.security.csrfSecret, sessionHash),
        sessionExpiresAt: session.expires_at.toISOString(),
        mfaRequired,
        user: {
          id: session.user_id,
          username: session.username,
          email: session.email,
          displayName: session.display_name,
          authSource: session.auth_source,
          areaId: session.area_id,
          mfaEnabled: session.mfa_enabled_at !== null,
        },
        permissions: stage === 'full' ? [...permissions].sort() : [],
      };
    },
  };
}
