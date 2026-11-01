import { createHash, randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers';
import { checkPassword } from '../../core/auth/password-policy.js';
import { createSessionRepository } from '../../core/auth/session.repository.js';
import { withTransaction } from '../../core/db/transaction.js';
import { ConflictError, RateLimitError, ValidationError } from '../../core/errors/errors.js';

// Password change and recovery by email for local accounts (A5, Parte B).
// AD accounts manage their password in AD.

const WINDOW_SECONDS = 15 * 60;
const FORGOT_PER_IP = 10;
const FORGOT_PER_EMAIL = 3;
const RESET_PER_IP = 20;

const hashResetToken = (token) => createHash('sha256').update(token, 'utf8').digest();

function assertPolicy(password, user) {
  const problems = checkPassword(password, { username: user.username, email: user.email });
  if (problems.length > 0) throw new ValidationError(problems.map((code) => ({ field: 'newPassword', code })));
}

export function createPasswordService(deps) {
  const { db, repository, credentials, audit, limiter, local, issuer, mailer, config, logger } = deps;

  async function throttle(name, limit) {
    const result = await limiter.hit(name, { limit, windowSeconds: WINDOW_SECONDS });
    if (!result.allowed) throw new RateLimitError(undefined, { retryAfterSeconds: result.retryAfterSeconds });
  }

  function sendResetMail(email, token) {
    // Fragment, not query string: the token never reaches server logs or a
    // Referer header (A5).
    const link = `${config.security.appOrigin}/#/restablecer-contrasena?token=${encodeURIComponent(token)}`;
    const minutes = config.passwordReset.ttlMinutes;
    // Sent after the response, so the response time does not reveal whether
    // the account exists.
    setImmediate(() => {
      mailer.send({
        to: email,
        tag: 'password-reset',
        subject: 'EnvioTec: restablecer contraseña / reset password',
        text: [
          'Recibimos una solicitud para restablecer su contraseña de EnvioTec.',
          `Use este enlace en los próximos ${minutes} minutos (un solo uso):`,
          link,
          'Si no la pidió, ignore este mensaje: su contraseña no cambia.',
          '',
          'We received a request to reset your EnvioTec password.',
          `Use this link within ${minutes} minutes (single use). If you did not ask for it, ignore this message.`,
        ].join('\n'),
      }).catch((error) => logger.error({ errorMessage: error.message }, 'password reset mail failed'));
    });
  }

  return {
    async change(auth, { currentPassword, newPassword }, context) {
      if (auth.user.authSource !== 'local') throw new ConflictError('La contraseña de las cuentas de AD se cambia en AD');
      await throttle(`password-change:user:${auth.user.id}`, 10);
      const user = await repository.findUserById(db, auth.user.id);
      const actorContext = { ...context, actor: { userId: auth.user.id, sessionHash: auth.sessionHash } };
      const check = await credentials.checkPassword(user, currentPassword, actorContext, 'auth.password_change');
      if (!check.valid) throw new ValidationError([{ field: 'currentPassword', code: 'invalid' }], 'La contraseña actual es incorrecta');
      assertPolicy(newPassword, user);
      if ((await local.verify(user.password_hash, newPassword)).valid) {
        throw new ValidationError([{ field: 'newPassword', code: 'same_as_current' }]);
      }

      const passwordHash = await local.hash(newPassword);
      return withTransaction(db, async (client) => {
        await repository.updatePassword(client, user.id, passwordHash);
        // A5: every other session is revoked; this one gets a new token.
        const revoked = await createSessionRepository(client).revokeAllForUser(user.id, 'password_change', {
          exceptHash: auth.sessionHash,
        });
        const rotated = await issuer.rotate(client, auth.sessionHash, { reason: 'password_change' });
        await audit.record(client, {
          actor: { userId: user.id, sessionHash: rotated.hash }, action: 'auth.password_change', resourceType: 'user',
          resourceId: user.id, result: 'success', context, metadata: { revokedSessions: revoked },
        });
        return rotated;
      });
    },

    // Always the same answer, whether or not the email belongs to an account.
    async forgot({ email }, context) {
      await throttle(`password-forgot:ip:${context.ip}`, FORGOT_PER_IP);
      const emailKey = createHash('sha256').update(email.toLowerCase()).digest('hex');
      const perEmail = await limiter.hit(`password-forgot:email:${emailKey}`, { limit: FORGOT_PER_EMAIL, windowSeconds: WINDOW_SECONDS });
      if (!perEmail.allowed) return;

      const user = await repository.findActiveLocalUserByEmail(db, email);
      if (!user) {
        await audit.record(db, {
          actor: { type: 'anonymous' }, action: 'auth.password_reset_request', resourceType: 'user', result: 'failure',
          context, metadata: { reason: 'no_local_account' },
        });
        return;
      }
      const token = randomBytes(32).toString('base64url');
      await withTransaction(db, async (client) => {
        await repository.invalidateResetTokens(client, user.id);
        await repository.createResetToken(client, {
          tokenHash: hashResetToken(token), userId: user.id, ttlMinutes: config.passwordReset.ttlMinutes,
        });
        await audit.record(client, {
          actor: { type: 'anonymous' }, action: 'auth.password_reset_request', resourceType: 'user', resourceId: user.id,
          result: 'success', context, metadata: { mailEnabled: mailer.enabled },
        });
      });
      sendResetMail(user.email, token);
    },

    async reset({ token, newPassword }, context) {
      await throttle(`password-reset:ip:${context.ip}`, RESET_PER_IP);
      const invalid = new ValidationError([{ field: 'token', code: 'invalid_or_expired' }], 'El enlace es inválido o venció');
      const tokenHash = hashResetToken(token);

      return withTransaction(db, async (client) => {
        const userId = await repository.findUsableResetToken(client, tokenHash);
        if (!userId) throw invalid;
        const user = await repository.findUserById(client, userId, { forUpdate: true });
        if (!user || user.auth_source !== 'local' || user.status !== 'active' || user.deleted_at || user.is_expired) {
          throw invalid;
        }
        assertPolicy(newPassword, user);

        await repository.invalidateResetTokens(client, user.id);
        await repository.updatePassword(client, user.id, await local.hash(newPassword));
        const revoked = await createSessionRepository(client).revokeAllForUser(user.id, 'password_reset');
        await audit.record(client, {
          actor: { type: 'anonymous' }, action: 'auth.password_reset', resourceType: 'user', resourceId: user.id,
          result: 'success', context, metadata: { revokedSessions: revoked },
        });
      });
    },
  };
}
