import { AuthorizationError } from '../errors/errors.js';

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
