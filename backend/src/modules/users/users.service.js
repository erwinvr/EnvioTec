import { randomBytes } from 'node:crypto';
import { actorFrom } from '../../core/audit/audit.service.js';
import { hashPassword } from '../../core/auth/password.js';
import { createSessionRepository } from '../../core/auth/session.repository.js';
import { areaScopeFor } from '../../core/authorization/area-scope.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/errors.js';
import {
  assertKeepsASuperadmin, assertLocal, assertNotSelf, initialExpiry, renewedExpiry,
} from './users.rules.js';

// Users (A6, Parte B). Every target is loaded through the actor's area scope,
// so a user outside it answers 404 like one that does not exist (IDOR).
// Sensitive actions require a recent reauthentication (A5) and every change
// revokes the sessions it affects and is audited in the same transaction.

const MAX_OFFSET = 10000;

// 20 random characters (120 bits), shown once to the administrator and
// changed by the user on first login (A5).
export const generateTemporaryPassword = () => randomBytes(15).toString('base64url');

export function toUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    authSource: row.auth_source,
    areaId: row.area_id,
    areaName: row.area_name,
    status: row.status,
    disabledReason: row.disabled_reason,
    mustChangePassword: row.must_change_password,
    mfaEnabled: row.mfa_enabled,
    lockedUntil: row.locked_until?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    exemptFromExpiry: row.exempt_from_expiry,
    isEmergency: row.is_emergency,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    roles: row.roles,
  };
}

const isSuperadmin = (row) => row.roles.some((role) => role.name === 'superadmin');

export function createUsersService({ db, repository, audit, config }) {
  async function inScope(client, auth, id, options) {
    const row = await repository.findInScope(client, areaScopeFor(auth), id, options);
    if (!row) throw new NotFoundError();
    return row;
  }

  function event(client, auth, context, action, target, metadata) {
    return audit.record(client, {
      actor: actorFrom(auth), action, resourceType: 'user', resourceId: target, result: 'success', context, metadata,
    });
  }

  async function assertArea(client, auth, areaId) {
    const area = await repository.findArea(client, areaId);
    const scope = areaScopeFor(auth);
    if (!area || !area.is_active || (!scope.all && scope.areaId !== areaId)) {
      throw new ValidationError([{ field: 'areaId', code: 'invalid_area' }]);
    }
  }

  async function validitySettings(client) {
    const s = await repository.getSettings(client, ['local_account.default_validity_days',
      'local_account.max_validity_days', 'local_account.renewal_max_days']);
    return {
      defaultDays: s['local_account.default_validity_days'],
      maxDays: s['local_account.max_validity_days'],
      renewalMaxDays: s['local_account.renewal_max_days'],
    };
  }

  return {
    async list(auth, filters, { page, pageSize, sort, direction }) {
      const offset = (page - 1) * pageSize;
      if (offset > MAX_OFFSET) throw new ValidationError([{ field: 'page', code: 'too_large' }]);
      const { rows, total } = await repository.list(db, areaScopeFor(auth), filters, { sort, direction, limit: pageSize, offset });
      return { items: rows.map(toUser), total };
    },

    async get(auth, id) {
      return toUser(await inScope(db, auth, id));
    },

    async reviewLocal(auth, { page, pageSize }) {
      const { rows, total } = await repository.listLocalReview(db, areaScopeFor(auth), { limit: pageSize, offset: (page - 1) * pageSize });
      return {
        total,
        items: rows.map((row) => ({
          id: row.id, username: row.username, displayName: row.display_name, areaName: row.area_name,
          lastLoginAt: row.last_login_at?.toISOString() ?? null, expiresAt: row.expires_at?.toISOString() ?? null,
          exemptFromExpiry: row.exempt_from_expiry, isEmergency: row.is_emergency, inactiveDays: row.inactive_days,
        })),
      };
    },

    async createLocal(auth, input, context) {
      return withTransaction(db, async (client) => {
        await assertArea(client, auth, input.areaId);
        const expiresAt = initialExpiry(input.expiresAt, await validitySettings(client));
        const temporaryPassword = generateTemporaryPassword();
        const id = await repository.createLocal(client, {
          ...input, passwordHash: await hashPassword(temporaryPassword, config.argon2), expiresAt, actorId: auth.user.id,
        });
        await event(client, auth, context, 'user.create', id, {
          authSource: 'local', areaId: input.areaId, expiresAt: expiresAt.toISOString(),
        });
        return { user: toUser(await repository.findInScope(client, { all: true }, id)), temporaryPassword };
      });
    },

    async update(auth, id, changes, context) {
      if ('email' in changes) assertRecentReauth(auth);
      return withTransaction(db, async (client) => {
        const before = await inScope(client, auth, id, { forUpdate: true });
        assertLocal(before);
        if ('areaId' in changes) await assertArea(client, auth, changes.areaId);
        await repository.updateProfile(client, id, changes, auth.user.id);
        const after = await repository.findInScope(client, { all: true }, id);
        const fields = Object.keys(changes);
        await event(client, auth, context, 'user.update', id, {
          before: Object.fromEntries(fields.map((f) => [f, toUser(before)[f]])),
          after: Object.fromEntries(fields.map((f) => [f, toUser(after)[f]])),
        });
        return toUser(after);
      });
    },

    async disable(auth, id, context) {
      assertRecentReauth(auth);
      assertNotSelf(auth.user.id, id, 'No puede desactivar su propia cuenta');
      return withTransaction(db, async (client) => {
        const target = await inScope(client, auth, id, { forUpdate: true });
        if (target.status === 'disabled') return toUser(target);
        assertKeepsASuperadmin({
          targetIsSuperadmin: isSuperadmin(target), targetIsEmergency: target.is_emergency, losesRole: true,
          otherActiveSuperadmins: await repository.countOtherActiveSuperadmins(client, id),
        });
        await repository.disable(client, id, 'manual', auth.user.id);
        const revoked = await createSessionRepository(client).revokeAllForUser(id, 'user_disabled');
        await event(client, auth, context, 'user.disable', id, { reason: 'manual', revokedSessions: revoked });
        return toUser(await repository.findInScope(client, { all: true }, id));
      });
    },

    async enable(auth, id, context) {
      assertRecentReauth(auth);
      return withTransaction(db, async (client) => {
        const target = await inScope(client, auth, id, { forUpdate: true });
        if (target.status === 'active') return toUser(target);
        if (target.auth_source === 'local' && !target.exempt_from_expiry && target.expires_at <= new Date()) {
          throw new ConflictError('La cuenta está vencida: renuévela para reactivarla');
        }
        await repository.enable(client, id, auth.user.id);
        await event(client, auth, context, 'user.enable', id, { previousReason: target.disabled_reason });
        return toUser(await repository.findInScope(client, { all: true }, id));
      });
    },

    async unlock(auth, id, context) {
      return withTransaction(db, async (client) => {
        const target = await inScope(client, auth, id, { forUpdate: true });
        await repository.unlock(client, id, auth.user.id);
        await event(client, auth, context, 'user.unlock', id, { wasLocked: target.locked_until !== null });
        return toUser(await repository.findInScope(client, { all: true }, id));
      });
    },

    async resetPassword(auth, id, context) {
      assertRecentReauth(auth);
      assertNotSelf(auth.user.id, id, 'Para su propia cuenta use el cambio de contraseña');
      return withTransaction(db, async (client) => {
        const target = await inScope(client, auth, id, { forUpdate: true });
        assertLocal(target, 'La contraseña de las cuentas de AD se cambia en AD');
        const temporaryPassword = generateTemporaryPassword();
        await repository.setTemporaryPassword(client, id, await hashPassword(temporaryPassword, config.argon2), auth.user.id);
        const revoked = await createSessionRepository(client).revokeAllForUser(id, 'password_reset_by_admin');
        await event(client, auth, context, 'user.password_reset', id, { revokedSessions: revoked });
        return { temporaryPassword };
      });
    },

    async renew(auth, id, { days, reason }, context) {
      assertRecentReauth(auth);
      assertNotSelf(auth.user.id, id, 'No puede renovar su propia cuenta');
      return withTransaction(db, async (client) => {
        const target = await inScope(client, auth, id, { forUpdate: true });
        assertLocal(target, 'Las cuentas de AD no tienen vigencia');
        if (target.exempt_from_expiry) throw new ConflictError('La cuenta está exenta de vigencia');
        const expiresAt = renewedExpiry(target.expires_at, days, await validitySettings(client));
        const status = await repository.renew(client, id, expiresAt, auth.user.id);
        await event(client, auth, context, 'user.renew', id, {
          reason, days, previousExpiresAt: target.expires_at?.toISOString() ?? null, expiresAt: expiresAt.toISOString(),
          reactivated: target.status === 'disabled' && status === 'active',
        });
        return toUser(await repository.findInScope(client, { all: true }, id));
      });
    },

    async listSessions(auth, id) {
      await inScope(db, auth, id);
      const rows = await createSessionRepository(db).listActiveForUser(id, config.session.idleTimeoutMin);
      return rows.map((row) => ({
        id: row.id.toString('hex'), createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
        expiresAt: row.expires_at.toISOString(), ip: row.ip, userAgent: row.user_agent, current: row.id.equals(auth.sessionHash),
      }));
    },

    async revokeSessions(auth, id, context) {
      return withTransaction(db, async (client) => {
        await inScope(client, auth, id);
        const revoked = await createSessionRepository(client).revokeAllForUser(id, 'revoked_by_admin');
        await event(client, auth, context, 'user.sessions_revoke', id, { revokedSessions: revoked });
        return { revoked };
      });
    },
  };
}
