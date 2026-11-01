import { createSessionRepository } from '../../core/auth/session.repository.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AuthenticationError, NotFoundError, RateLimitError, ValidationError } from '../../core/errors/errors.js';

// The signed-in user's own account: logout, own sessions and
// reauthentication (A5).

const WINDOW_SECONDS = 15 * 60;
const REAUTH_PER_WINDOW = 10;

export function createAccountService(deps) {
  const { db, repository, credentials, mfa, audit, limiter, config } = deps;
  const actorOf = (auth) => ({ userId: auth.user.id, sessionHash: auth.sessionHash });

  return {
    async logout(auth, context) {
      await withTransaction(db, async (client) => {
        await createSessionRepository(client).revoke(auth.sessionHash, 'logout');
        await audit.record(client, {
          actor: actorOf(auth), action: 'auth.logout', resourceType: 'session', result: 'success', context,
        });
      });
    },

    async listSessions(auth) {
      const rows = await createSessionRepository(db).listActiveForUser(auth.user.id, config.session.idleTimeoutMin);
      return rows.map((row) => ({
        id: row.id.toString('hex'),
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        ip: row.ip,
        userAgent: row.user_agent,
        current: row.id.equals(auth.sessionHash),
      }));
    },

    // Only the user's own sessions (the WHERE includes user_id): another
    // user's session ID answers 404, like one that does not exist (IDOR).
    async revokeSession(auth, sessionId, context) {
      const hash = Buffer.from(sessionId, 'hex');
      return withTransaction(db, async (client) => {
        if (!await createSessionRepository(client).revokeOwn(auth.user.id, hash, 'user_revoked')) throw new NotFoundError();
        await audit.record(client, {
          actor: actorOf(auth), action: 'auth.session_revoke', resourceType: 'session', resourceId: sessionId,
          result: 'success', context,
        });
        return { current: hash.equals(auth.sessionHash) };
      });
    },

    // Password (local or AD) or a TOTP code; valid for 5 minutes. For AD
    // accounts the AD state is checked again (Parte B).
    async reauthenticate(auth, { password, code }, context) {
      const result = await limiter.hit(`reauth:user:${auth.user.id}`, { limit: REAUTH_PER_WINDOW, windowSeconds: WINDOW_SECONDS });
      if (!result.allowed) throw new RateLimitError(undefined, { retryAfterSeconds: result.retryAfterSeconds });
      const actorContext = { ...context, actor: actorOf(auth) };
      const user = await repository.findUserById(db, auth.user.id);

      let method;
      if (code !== undefined) {
        method = 'totp';
        if (!await mfa.checkCode(user.id, code)) {
          await audit.record(db, {
            actor: actorOf(auth), action: 'auth.reauth', resourceType: 'user', resourceId: user.id, result: 'failure',
            context, metadata: { method, reason: 'invalid_code' },
          });
          throw new ValidationError([{ field: 'code', code: 'invalid_code' }], 'Código incorrecto');
        }
      } else {
        method = 'password';
        const check = await credentials.checkPassword(user, password, actorContext, 'auth.reauth');
        if (!check.valid) {
          throw new ValidationError([{ field: 'password', code: 'invalid' }], 'Contraseña incorrecta');
        }
        if (user.auth_source === 'ad') {
          const mappings = await repository.listAdGroupMappings(db);
          const access = await credentials.checkAdAccess(user, check.adEntry, mappings.map((m) => m.group_dn), actorContext, 'auth.reauth');
          if (!access.allowed) throw new AuthenticationError();
        }
      }

      await withTransaction(db, async (client) => {
        await createSessionRepository(client).markReauthenticated(auth.sessionHash);
        await audit.record(client, {
          actor: actorOf(auth), action: 'auth.reauth', resourceType: 'user', resourceId: user.id, result: 'success',
          context, metadata: { method },
        });
      });
    },
  };
}
