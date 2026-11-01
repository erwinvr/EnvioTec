import { AuthorizationError, ConflictError, ValidationError } from '../../core/errors/errors.js';

// Business rules of the users module as pure functions, so every case of the
// privilege-escalation rules (A6) is tested on its own.

const DAY_MS = 24 * 60 * 60 * 1000;

export function assertNotSelf(actorId, targetId, message) {
  if (actorId === targetId) throw new ConflictError(message);
}

export function assertLocal(target, message = 'Los datos de las cuentas de AD se administran en AD') {
  if (target.auth_source !== 'local') throw new ConflictError(message);
}

// A6 rules 1, 2 and 4, and AD-owned roles:
//   1. nobody grants or removes a role with permissions they do not hold
//   2. nobody changes their own roles
//   4. an AD account never receives an administrative role (also enforced by
//      a database trigger, ADR-007)
//   -  roles that come from AD groups are not edited by hand
// Returns { added, removed } (role ids of the manual roles).
export function checkRoleChange({ actor, target, currentRoles, requestedIds, rolesById }) {
  assertNotSelf(actor.id, target.id, 'No puede modificar sus propios roles');

  const unknown = requestedIds.filter((id) => !rolesById.has(id));
  if (unknown.length > 0) throw new ValidationError(unknown.map(() => ({ field: 'roleIds', code: 'unknown_role' })));

  const fromAd = new Set(currentRoles.filter((role) => role.source === 'ad_group').map((role) => role.id));
  if (requestedIds.some((id) => fromAd.has(id))) {
    throw new ValidationError([{ field: 'roleIds', code: 'role_from_ad_group' }], 'Ese rol lo asigna un grupo de AD');
  }
  const manual = new Set(currentRoles.filter((role) => role.source === 'manual').map((role) => role.id));
  const requested = new Set(requestedIds);
  const added = [...requested].filter((id) => !manual.has(id));
  const removed = [...manual].filter((id) => !requested.has(id));

  for (const id of [...added, ...removed]) {
    const role = rolesById.get(id);
    const missing = role.permissions.filter((code) => !actor.permissions.has(code));
    if (missing.length > 0) {
      throw new AuthorizationError('No puede asignar ni quitar un rol con permisos que usted no tiene', {
        code: 'PRIVILEGE_ESCALATION', details: [{ field: 'roleIds', code: 'exceeds_own_permissions' }],
      });
    }
  }
  if (target.auth_source === 'ad' && added.some((id) => rolesById.get(id).administrative)) {
    throw new ValidationError([{ field: 'roleIds', code: 'administrative_role_for_ad' }],
      'Las cuentas de AD no pueden tener roles administrativos');
  }
  return { added, removed };
}

// A6 rule 3: the last active superadmin (not counting the emergency
// account) can be neither disabled nor stripped of the role.
export function assertKeepsASuperadmin({ targetIsSuperadmin, targetIsEmergency, losesRole, otherActiveSuperadmins }) {
  if (targetIsSuperadmin && !targetIsEmergency && losesRole && otherActiveSuperadmins === 0) {
    throw new ConflictError('Debe quedar al menos un superadmin activo');
  }
}

// Expiry of a new local account: default term unless one is given, always
// in the future and never beyond the maximum (Parte B).
export function initialExpiry(requested, { defaultDays, maxDays }, nowMs = Date.now()) {
  const expires = requested ? new Date(requested) : new Date(nowMs + defaultDays * DAY_MS);
  if (expires.getTime() <= nowMs) throw new ValidationError([{ field: 'expiresAt', code: 'in_the_past' }]);
  if (expires.getTime() > nowMs + maxDays * DAY_MS) {
    throw new ValidationError([{ field: 'expiresAt', code: 'exceeds_max_validity' }], `La vigencia máxima es de ${maxDays} días`);
  }
  return expires;
}

// Renewal: extends from the current expiry (or from now, if already
// expired) by at most renewal_max_days, and never beyond max_validity_days
// from today.
export function renewedExpiry(currentExpiresAt, days, { renewalMaxDays, maxDays }, nowMs = Date.now()) {
  if (days > renewalMaxDays) {
    throw new ValidationError([{ field: 'days', code: 'exceeds_renewal_max' }], `Cada renovación extiende como máximo ${renewalMaxDays} días`);
  }
  const base = Math.max(nowMs, currentExpiresAt ? new Date(currentExpiresAt).getTime() : nowMs);
  const expires = new Date(base + days * DAY_MS);
  if (expires.getTime() > nowMs + maxDays * DAY_MS) {
    throw new ValidationError([{ field: 'days', code: 'exceeds_max_validity' }], `La vigencia máxima es de ${maxDays} días desde hoy`);
  }
  return expires;
}
