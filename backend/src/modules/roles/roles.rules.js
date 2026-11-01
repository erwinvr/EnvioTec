import { AuthorizationError, ConflictError, ValidationError } from '../../core/errors/errors.js';

// Anti-escalation rules for roles (A6) as pure functions, tested branch by
// branch. Permission codes come from the catalog; `catalog` maps each code to
// { administrative }.

function escalation() {
  return new AuthorizationError('No puede otorgar ni quitar permisos que usted no tiene', {
    code: 'PRIVILEGE_ESCALATION', details: [{ field: 'permissions', code: 'exceeds_own_permissions' }],
  });
}

export function assertKnownPermissions(codes, catalog) {
  const unknown = codes.filter((code) => !catalog.has(code));
  if (unknown.length > 0) throw new ValidationError(unknown.map(() => ({ field: 'permissions', code: 'unknown_permission' })));
}

// Rule 1 on creation: a new role holds only permissions its creator holds.
export function checkNewRole({ actorPermissions, codes, catalog }) {
  assertKnownPermissions(codes, catalog);
  if (codes.some((code) => !actorPermissions.has(code))) throw escalation();
}

// Replacing the permissions of a role:
//   rule 4  system roles never change (also a database trigger)
//   own     nobody changes a role they hold themselves
//   rule 1  nobody grants or removes a permission they do not hold
//   ADR-007 a role held by AD accounts or mapped from an AD group gets no
//           administrative permission (also a database trigger)
// Returns { added, removed }.
export function checkPermissionChange({ actor, role, currentCodes, requestedCodes, catalog }) {
  if (role.isSystem) throw new ConflictError('Los permisos de un rol de sistema no se modifican');
  if (actor.roleIds.has(role.id)) throw new ConflictError('No puede modificar los permisos de un rol que usted tiene');
  assertKnownPermissions(requestedCodes, catalog);

  const current = new Set(currentCodes);
  const requested = new Set(requestedCodes);
  const added = [...requested].filter((code) => !current.has(code));
  const removed = [...current].filter((code) => !requested.has(code));
  if ([...added, ...removed].some((code) => !actor.permissions.has(code))) throw escalation();
  if (role.usedFromAd && added.some((code) => catalog.get(code).administrative)) {
    throw new ValidationError([{ field: 'permissions', code: 'administrative_permission_for_ad_role' }],
      'Un rol usado por cuentas o grupos de AD no puede tener permisos administrativos');
  }
  return { added, removed };
}

export function assertRenamable(role, changes) {
  if (role.isSystem && 'name' in changes && changes.name !== role.name) {
    throw new ConflictError('Un rol de sistema no se renombra');
  }
}

// Rule 5: a role in use is not deleted without an explicit reassignment;
// rule 4: a system role is never deleted.
export function assertDeletable(role) {
  if (role.isSystem) throw new ConflictError('Un rol de sistema no se borra');
  if (role.userCount > 0) throw new ConflictError('El rol está asignado a usuarios: reasígnelos antes de borrarlo');
  if (role.mappingCount > 0) throw new ConflictError('El rol está asociado a grupos de AD: quite esas equivalencias antes');
}
