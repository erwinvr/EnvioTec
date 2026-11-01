import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers';
import { createSessionRepository } from '../../core/auth/session.repository.js';
import { withTransaction } from '../../core/db/transaction.js';
import { InvalidCredentialsError, RateLimitError } from '../../core/errors/errors.js';
import { createAdSync } from './ad-sync.js';

// Login (A5, ADR-006): one provider per account, chosen by auth_source; AD
// accounts that do not exist yet are created on their first successful login
// (JIT). Every failure ends in the same InvalidCredentialsError.

const WINDOW_SECONDS = 15 * 60;
const INFLIGHT_MS = 15000;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const accountKey = (username) => createHash('sha256').update(username.toLowerCase()).digest('hex');

export function createLoginService(deps) {
  const { db, repository, credentials, audit, limiter, local, ad, issuer, config, mailer, logger } = deps;

  // The emergency account bypasses AD; every use alerts the administrators
  // (Parte B). Sent after the response, never blocking the login.
  async function alertEmergencyUse(user, context) {
    const recipients = await repository.getListSetting(db, 'notifications.admin_emails');
    if (recipients.length === 0) logger.warn({ userId: user.id }, 'emergency account used and notifications.admin_emails is empty');
    setImmediate(() => {
      for (const to of recipients) {
        mailer.send({
          to,
          tag: 'emergency-login',
          subject: 'EnvioTec: se usó la cuenta de emergencia / emergency account used',
          text: [
            `La cuenta de emergencia "${user.username}" inició sesión en EnvioTec.`,
            `Fecha (UTC): ${new Date().toISOString()}`,
            `IP: ${context.ip}`,
            'Si no corresponde a una contingencia autorizada, revise la auditoría y revoque sus sesiones.',
          ].join('\n'),
        }).catch((error) => logger.error({ errorMessage: error.message }, 'emergency alert mail failed'));
      }
    });
  }

  async function throttle(name, limit) {
    const result = await limiter.hit(name, { limit, windowSeconds: WINDOW_SECONDS });
    if (!result.allowed) throw new RateLimitError(undefined, { retryAfterSeconds: result.retryAfterSeconds });
  }

  function fail(context, reason, { userId = null, username } = {}) {
    return audit.record(db, {
      actor: { type: 'anonymous' }, action: 'auth.login', resourceType: 'user', resourceId: userId,
      result: 'failure', context, metadata: { reason, username },
    });
  }

  async function startSession(client, userId, context, metadata) {
    if (context.currentSessionHash) await createSessionRepository(client).revoke(context.currentSessionHash, 'replaced');
    const issued = await issuer.issue(client, userId, context);
    await audit.record(client, {
      actor: { userId, sessionHash: issued.hash }, action: 'auth.login', resourceType: 'user', resourceId: userId,
      result: 'success', context, metadata,
    });
    return issued;
  }

  const adSync = createAdSync({ repository, audit });
  const syncAdAccount = (...args) => adSync.apply(...args);

  function hasValidAdData(entry) {
    return Boolean(entry.objectGuid && USERNAME_PATTERN.test(entry.username ?? '')
      && EMAIL_PATTERN.test(entry.email ?? '') && entry.email.length <= 254);
  }

  async function loginExisting(user, password, context) {
    if (user.deleted_at) {
      await local.dummyVerify(password);
      await fail(context, 'deleted', { userId: user.id });
      throw new InvalidCredentialsError();
    }
    const check = await credentials.checkPassword(user, password, context, 'auth.login');
    if (!check.valid) throw new InvalidCredentialsError();
    if (user.status !== 'active' || user.is_expired) {
      await fail(context, user.status !== 'active' ? 'disabled' : 'account_expired', { userId: user.id });
      throw new InvalidCredentialsError();
    }

    let mappings = [];
    let groups = new Set();
    if (user.auth_source === 'ad') {
      mappings = await repository.listAdGroupMappings(db);
      const access = await credentials.checkAdAccess(user, check.adEntry, mappings.map((m) => m.group_dn), context, 'auth.login');
      if (!access.allowed) throw new InvalidCredentialsError();
      groups = access.groups;
      const entry = check.adEntry;
      if (!hasValidAdData(entry) || await repository.emailOrUsernameTaken(db, { ...entry, exceptId: user.id })) {
        await audit.record(db, {
          actor: { type: 'system' }, action: 'auth.ad_collision', resourceType: 'user', resourceId: user.id,
          result: 'denied', context, metadata: { reason: 'ad_data_conflict' },
        });
        throw new InvalidCredentialsError();
      }
    }

    const issued = await withTransaction(db, async (client) => {
      if (user.auth_source === 'ad') await syncAdAccount(client, user.id, check.adEntry, groups, mappings, context);
      const passwordHash = check.needsRehash ? await local.hash(password) : null;
      await repository.registerSuccess(client, user.id, { passwordHash });
      const session = await startSession(client, user.id, context, { authSource: user.auth_source, rehashed: passwordHash !== null });
      if (user.is_emergency) {
        await audit.record(client, {
          actor: { userId: user.id, sessionHash: session.hash }, action: 'auth.emergency_login', resourceType: 'user',
          resourceId: user.id, result: 'success', context, metadata: { highlighted: true },
        });
      }
      return session;
    });
    if (user.is_emergency) await alertEmergencyUse(user, context);
    return issued;
  }

  async function loginNewAdUser(username, password, context) {
    const failuresKey = `ad:failures:${accountKey(username)}`;
    if (await limiter.count(failuresKey) >= config.lockout.adThreshold) {
      await fail(context, 'locked', { username });
      throw new InvalidCredentialsError();
    }
    const result = await ad.authenticate(username, password);
    if (result.status !== 'ok') {
      await limiter.hit(failuresKey, { limit: Number.POSITIVE_INFINITY, windowSeconds: config.lockout.adMinutes * 60 });
      await fail(context, 'unknown_user_or_invalid_password', { username });
      throw new InvalidCredentialsError();
    }
    await limiter.reset(failuresKey);
    const { entry } = result;

    // Renamed in AD: the account is found by objectGUID, never by name.
    const renamed = entry.objectGuid ? await repository.findUserByAdGuid(db, entry.objectGuid) : null;
    if (renamed) return loginRenamed(renamed, entry, context);

    if (!hasValidAdData(entry)) {
      await fail(context, 'ad_invalid_data', { username });
      throw new InvalidCredentialsError();
    }
    const mappings = await repository.listAdGroupMappings(db);
    const access = await ad.evaluate(entry, mappings.map((m) => m.group_dn));
    if (!access.allowed) {
      await fail(context, access.reason, { username });
      throw new InvalidCredentialsError();
    }
    if (await repository.emailOrUsernameTaken(db, entry)) {
      // A person has a single account: never merged automatically (Parte B).
      await audit.record(db, {
        actor: { type: 'system' }, action: 'auth.ad_collision', resourceType: 'user', result: 'denied', context,
        metadata: { reason: 'username_or_email_taken', username: entry.username },
      });
      throw new InvalidCredentialsError();
    }

    return withTransaction(db, async (client) => {
      const areaId = await repository.findAreaByDepartment(client, entry.department);
      const userId = await repository.createAdUser(client, entry, areaId);
      await audit.record(client, {
        actor: { type: 'system' }, action: 'user.create', resourceType: 'user', resourceId: userId, result: 'success',
        context, metadata: { source: 'ad_jit', authSource: 'ad', areaAssigned: areaId !== null },
      });
      await syncAdAccount(client, userId, entry, access.groups, mappings, context);
      return startSession(client, userId, context, { authSource: 'ad', provisioned: true });
    });
  }

  async function loginRenamed(user, entry, context) {
    if (user.deleted_at || user.status !== 'active') {
      await fail(context, user.deleted_at ? 'deleted' : 'disabled', { userId: user.id });
      throw new InvalidCredentialsError();
    }
    const mappings = await repository.listAdGroupMappings(db);
    const access = await credentials.checkAdAccess(user, entry, mappings.map((m) => m.group_dn), context, 'auth.login');
    if (!access.allowed) throw new InvalidCredentialsError();
    if (!hasValidAdData(entry) || await repository.emailOrUsernameTaken(db, { ...entry, exceptId: user.id })) {
      await audit.record(db, {
        actor: { type: 'system' }, action: 'auth.ad_collision', resourceType: 'user', resourceId: user.id,
        result: 'denied', context, metadata: { reason: 'ad_data_conflict' },
      });
      throw new InvalidCredentialsError();
    }
    return withTransaction(db, async (client) => {
      await syncAdAccount(client, user.id, entry, access.groups, mappings, context);
      await repository.registerSuccess(client, user.id);
      return startSession(client, user.id, context, { authSource: 'ad', renamed: true });
    });
  }

  return {
    async login({ username, password }, context) {
      const key = accountKey(username);
      await throttle(`login:ip:${context.ip}`, config.rateLimit.loginPerIp);
      await throttle(`login:account:${key}`, config.rateLimit.loginPerAccount);
      // One attempt at a time per account: parallel guesses cannot overtake
      // the lockout counter (and AD's own limit of 3).
      const release = await limiter.acquire(`login:inflight:${key}`, INFLIGHT_MS);
      if (!release) throw new RateLimitError();
      try {
        const user = await repository.findUserByUsername(db, username);
        if (user) return await loginExisting(user, password, context);
        if (ad.enabled) return await loginNewAdUser(username, password, context);
        await local.dummyVerify(password);
        await fail(context, 'unknown_user', { username });
        throw new InvalidCredentialsError();
      } finally {
        await release();
      }
    },
  };
}
