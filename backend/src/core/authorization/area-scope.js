import { AreaWriteDeniedError, AuthorizationError, NotFoundError } from '../errors/errors.js';

// Data scope by area (ADR-008). Every repository query on business data must
// receive a scope and add areaCondition() to its WHERE clause.
//   { all: true }               user with areas.view_all
//   { all: false, areaId }      user restricted to their area
// A user without an area and without areas.view_all has no scope: any access
// to business data is denied.

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

// Accepts "column" or "alias.column", each part a lowercase SQL identifier.
function isSafeColumn(column) {
  const parts = typeof column === 'string' ? column.split('.') : [];
  return parts.length >= 1 && parts.length <= 2 && parts.every((part) => IDENTIFIER_PATTERN.test(part));
}

export function areaScopeFor(auth) {
  if (auth?.permissions?.has('areas.view_all')) return Object.freeze({ all: true });
  return writeScopeFor(auth);
}

// Scope for changing business data (templates, contacts, campaigns and
// their workflow): always the user's own area. areas.view_all only widens
// what a user can read (Parte B), so an operator or approver who also holds
// a reporting role still writes and approves only in their area (ADR-026).
export function writeScopeFor(auth) {
  if (auth?.user?.areaId) return Object.freeze({ all: false, areaId: auth.user.areaId });
  return null;
}

// Returns a parameterized SQL condition and pushes its value into `params`.
// `column` is an identifier written by the developer, validated against a
// strict pattern; it never comes from user input.
export function areaCondition(scope, column, params) {
  if (!isSafeColumn(column)) throw new Error(`invalid column name for area condition: ${column}`);
  if (!scope) throw new AuthorizationError();
  if (scope.all === true) return 'TRUE';
  if (typeof scope.areaId !== 'string' || scope.areaId === '') throw new AuthorizationError();
  params.push(scope.areaId);
  return `${column} = $${params.length}`;
}

// Finds a record to change it. `find(scope)` runs the repository lookup.
// In the user's own area: the row. Readable only through areas.view_all:
// 403, audited. Otherwise: 404, so other areas' records are not revealed.
export async function findForWrite(auth, { resourceType, id, find }) {
  const row = await find(writeScopeFor(auth));
  if (row) return row;
  if (auth?.permissions?.has('areas.view_all') && await find(areaScopeFor(auth), { lock: false })) {
    throw new AreaWriteDeniedError(resourceType, id);
  }
  throw new NotFoundError();
}
