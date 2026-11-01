import { createHash, randomBytes } from 'node:crypto';
import { renderSVG } from 'uqr';
import { createSessionRepository } from '../../core/auth/session.repository.js';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from '../../core/auth/totp.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import {
  AuthenticationError, ConflictError, NotFoundError, RateLimitError, ValidationError,
} from '../../core/errors/errors.js';
import { decryptSecret, encryptSecret } from '../../core/security/encryption.js';

// MFA (A5, ADR-006): TOTP with an encrypted secret, 10 one-time recovery
// codes, and for AD accounts a one-time enrollment code issued by an
// administrator and delivered through another channel.

const ISSUER = 'EnvioTec';
const RECOVERY_CODES = 10;
const MAX_SESSION_FAILURES = 5;
const MAX_ENROLLMENT_ATTEMPTS = 5;
const PENDING_TTL_SECONDS = 10 * 60;
const WINDOW_SECONDS = 15 * 60;
const USER_ATTEMPTS_PER_WINDOW = 10;

export const normalizeCode = (code) => code.toUpperCase().replace(/[\s-]/g, '');
export const hashCode = (code) => createHash('sha256').update(normalizeCode(code)).digest();

// Random code in base32, grouped for reading aloud: 16 characters (80 bits)
// for enrollment codes, 10 (50 bits) for recovery codes.
export function generateCode(length, groupSize) {
  const raw = base32Encode(randomBytes(Math.ceil((length * 5) / 8))).slice(0, length);
  const groups = [];
  for (let i = 0; i < raw.length; i += groupSize) groups.push(raw.slice(i, i + groupSize));
  return groups.join('-');
}

export function createMfaService({ db, repository, mfaRepository, audit, limiter, issuer, config }) {
  const key = config.security.dataEncryptionKey;
  const event = (auth, context, fields) => audit.record(fields.client ?? db, {
    actor: { userId: auth.user.id, sessionHash: auth.sessionHash }, resourceType: 'user', resourceId: auth.user.id,
    context, ...fields, client: undefined,
  });

  async function throttleUser(userId) {
    const result = await limiter.hit(`mfa:user:${userId}`, { limit: USER_ATTEMPTS_PER_WINDOW, windowSeconds: WINDOW_SECONDS });
    if (!result.allowed) throw new RateLimitError(undefined, { retryAfterSeconds: result.retryAfterSeconds });
  }

  // Too many wrong codes in one session end the session: the attacker has
  // to get through the password (and its lockout) again.
  async function sessionFailure(auth, context, reason) {
    const failures = await createSessionRepository(db).addFailedMfa(auth.sessionHash);
    await event(auth, context, { action: 'auth.mfa_verify', result: 'failure', metadata: { reason, failures } });
    if (failures >= MAX_SESSION_FAILURES) {
      await createSessionRepository(db).revoke(auth.sessionHash, 'mfa_failures');
      throw new AuthenticationError();
    }
    throw new ValidationError([{ field: 'code', code: 'invalid_code' }], 'Código incorrecto');
  }

  async function checkTotp(client, userId, code) {
    const user = await repository.findUserById(client, userId);
    if (!user?.mfa_secret_encrypted) return false;
    const secret = decryptSecret(key, user.mfa_secret_encrypted, `mfa:${userId}`);
    const step = verifyTotp(secret, code);
    return step !== null && mfaRepository.consumeTotpStep(client, userId, step);
  }

  async function finishEnrollment(client, auth, secret, step, context, metadata) {
    if (!await mfaRepository.enableMfa(client, auth.user.id, encryptSecret(key, secret, `mfa:${auth.user.id}`), step)) {
      throw new ConflictError('El MFA ya está configurado');
    }
    const codes = Array.from({ length: RECOVERY_CODES }, () => generateCode(10, 5));
    await mfaRepository.replaceRecoveryCodes(client, auth.user.id, codes.map(hashCode));
    const rotated = await issuer.rotate(client, auth.sessionHash, { mfaVerified: true, reason: 'mfa_enrolled' });
    await event(auth, context, { client, action: 'auth.mfa_enable', result: 'success', metadata });
    return { rotated, recoveryCodes: codes };
  }

  return {
    // Accepts a TOTP code or a recovery code (stage mfa_verify).
    async verify(auth, { code, recoveryCode }, context) {
      await throttleUser(auth.user.id);
      return withTransaction(db, async (client) => {
        const valid = code !== undefined
          ? await checkTotp(client, auth.user.id, code)
          : await mfaRepository.consumeRecoveryCode(client, auth.user.id, hashCode(recoveryCode));
        if (!valid) return null;
        const rotated = await issuer.rotate(client, auth.sessionHash, { mfaVerified: true, reason: 'mfa_verified' });
        await event(auth, context, {
          client, action: 'auth.mfa_verify', result: 'success', metadata: { method: code !== undefined ? 'totp' : 'recovery_code' },
        });
        return rotated;
      }).then((rotated) => rotated ?? sessionFailure(auth, context, 'invalid_code'));
    },

    // TOTP check used by reauthentication.
    async checkCode(userId, code) {
      return withTransaction(db, (client) => checkTotp(client, userId, code));
    },

    async enrollStart(auth, { enrollmentCode }, context) {
      if (auth.user.mfaEnabled) throw new ConflictError('El MFA ya está configurado');
      // Outside the first login, configuring MFA requires reauthentication (A5).
      if (auth.stage === 'full') assertRecentReauth(auth);
      await throttleUser(auth.user.id);

      let enrollmentCodeId = null;
      if (auth.user.authSource === 'ad') {
        // AD passwords alone cannot enroll a device (ADR-006: no trust on first use).
        enrollmentCodeId = typeof enrollmentCode === 'string'
          ? await mfaRepository.findValidEnrollmentCode(db, auth.user.id, hashCode(enrollmentCode), MAX_ENROLLMENT_ATTEMPTS)
          : null;
        if (!enrollmentCodeId) {
          await mfaRepository.addEnrollmentFailure(db, auth.user.id);
          await event(auth, context, { action: 'auth.mfa_enrollment_code_use', result: 'failure', metadata: { reason: 'invalid_code' } });
          throw new ValidationError([{ field: 'enrollmentCode', code: 'invalid_code' }], 'Código de enrolamiento inválido o vencido');
        }
      }

      const secret = generateTotpSecret();
      const pending = JSON.stringify({
        secret: encryptSecret(key, secret, `mfa-pending:${auth.user.id}`).toString('base64'), enrollmentCodeId,
      });
      await limiter.setValue(`mfa:pending:${auth.sessionHash.toString('hex')}`, pending, PENDING_TTL_SECONDS);
      const uri = otpauthUri(secret, { issuer: ISSUER, account: auth.user.username });
      // QR as an SVG image (uqr, phase 7): the frontend shows it through
      // img-src data:, without inserting markup into the page.
      const qrDataUri = `data:image/svg+xml;base64,${Buffer.from(renderSVG(uri, { ecc: 'M' })).toString('base64')}`;
      return { secret: base32Encode(secret), otpauthUri: uri, qrDataUri };
    },

    async enrollConfirm(auth, { code }, context) {
      await throttleUser(auth.user.id);
      const raw = await limiter.getValue(`mfa:pending:${auth.sessionHash.toString('hex')}`);
      if (!raw) throw new ValidationError([{ field: 'code', code: 'enrollment_not_started' }], 'Inicie de nuevo la configuración');
      const pending = JSON.parse(raw);
      const secret = decryptSecret(key, Buffer.from(pending.secret, 'base64'), `mfa-pending:${auth.user.id}`);
      const step = verifyTotp(secret, code);
      if (step === null) throw new ValidationError([{ field: 'code', code: 'invalid_code' }], 'Código incorrecto');

      const result = await withTransaction(db, async (client) => {
        if (pending.enrollmentCodeId) {
          if (!await mfaRepository.useEnrollmentCode(client, pending.enrollmentCodeId, MAX_ENROLLMENT_ATTEMPTS)) {
            throw new ValidationError([{ field: 'enrollmentCode', code: 'invalid_code' }], 'Código de enrolamiento inválido o vencido');
          }
          await event(auth, context, { client, action: 'auth.mfa_enrollment_code_use', result: 'success' });
        }
        return finishEnrollment(client, auth, secret, step, context, { authSource: auth.user.authSource });
      });
      await limiter.reset(`mfa:pending:${auth.sessionHash.toString('hex')}`);
      return result;
    },

    // Administrator action (users.reset_mfa + reauthentication): removes the
    // user's MFA and revokes their sessions. For AD accounts it also issues
    // the enrollment code, shown only once.
    async adminReset(auth, targetId, context) {
      assertRecentReauth(auth);
      return withTransaction(db, async (client) => {
        const target = await repository.findUserById(client, targetId, { forUpdate: true });
        if (!target || target.deleted_at) throw new NotFoundError();
        if (target.id === auth.user.id) throw new ConflictError('No puede reiniciar su propio MFA');

        await mfaRepository.disableMfa(client, target.id, auth.user.id);
        await mfaRepository.expireEnrollmentCodes(client, target.id);
        const revoked = await createSessionRepository(client).revokeAllForUser(target.id, 'mfa_reset');
        const actor = { userId: auth.user.id, sessionHash: auth.sessionHash };
        await audit.record(client, {
          actor, action: 'user.mfa_reset', resourceType: 'user', resourceId: target.id, result: 'success', context,
          metadata: { hadMfa: target.mfa_enabled_at !== null, revokedSessions: revoked },
        });
        if (target.auth_source !== 'ad') return { enrollmentCode: null, expiresAt: null };

        const validityHours = await repository.getIntegerSetting(client, 'mfa.enrollment_code_validity_hours') ?? 24;
        const code = generateCode(16, 4);
        const row = await mfaRepository.createEnrollmentCode(client, {
          userId: target.id, codeHash: hashCode(code), issuedBy: auth.user.id, validityHours,
        });
        await audit.record(client, {
          actor, action: 'user.mfa_enrollment_code_issue', resourceType: 'user', resourceId: target.id,
          result: 'success', context, metadata: { validityHours, expiresAt: row.expires_at.toISOString() },
        });
        return { enrollmentCode: code, expiresAt: row.expires_at.toISOString() };
      });
    },
  };
}
