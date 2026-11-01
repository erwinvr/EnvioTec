import { successSchema } from '../../core/http/response.js';
import { SORT_COLUMNS } from './users.repository.js';

const uuid = { type: 'string', format: 'uuid' };
const email = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' };
const displayName = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const nullableString = { type: ['string', 'null'] };
const paging = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};
const object = (properties, required = [], extra = {}) => ({
  type: 'object', additionalProperties: false, required, properties, ...extra,
});

export const idParams = object({ id: uuid }, ['id']);

export const listQuery = object({
  ...paging,
  search: { type: 'string', minLength: 1, maxLength: 100 },
  status: { type: 'string', enum: ['active', 'disabled', 'locked'] },
  authSource: { type: 'string', enum: ['local', 'ad'] },
  areaId: uuid,
  roleId: uuid,
  sort: { type: 'string', enum: Object.keys(SORT_COLUMNS), default: 'username' },
  direction: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
});
export const reviewQuery = object(paging);

// Mass assignment (A8): only these fields; status, roles, auth_source or the
// password never come from these bodies.
export const createBody = object({
  username: { type: 'string', pattern: '^[A-Za-z0-9._-]{3,64}$' },
  email,
  displayName,
  areaId: uuid,
  expiresAt: { type: 'string', format: 'date-time' },
}, ['username', 'email', 'displayName', 'areaId']);
export const updateBody = object({ displayName, email, areaId: uuid }, [], { minProperties: 1 });
export const rolesBody = object({ roleIds: { type: 'array', maxItems: 50, items: uuid } }, ['roleIds']);
export const renewBody = object({
  days: { type: 'integer', minimum: 1, maximum: 365 },
  reason: { type: 'string', minLength: 10, maxLength: 500, pattern: '\\S' },
}, ['days', 'reason']);

const user = object({
  id: { type: 'string' }, username: { type: 'string' }, email: { type: 'string' }, displayName: { type: 'string' },
  authSource: { type: 'string' }, areaId: nullableString, areaName: nullableString, status: { type: 'string' },
  disabledReason: nullableString, mustChangePassword: { type: 'boolean' }, mfaEnabled: { type: 'boolean' },
  lockedUntil: nullableString, expiresAt: nullableString, exemptFromExpiry: { type: 'boolean' },
  isEmergency: { type: 'boolean' }, lastLoginAt: nullableString, createdAt: { type: 'string' },
  roles: {
    type: 'array',
    items: object({ id: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' } }, ['id', 'name', 'source']),
  },
}, ['id', 'username', 'email', 'displayName', 'authSource', 'areaId', 'areaName', 'status', 'disabledReason',
  'mustChangePassword', 'mfaEnabled', 'lockedUntil', 'expiresAt', 'exemptFromExpiry', 'isEmergency', 'lastLoginAt',
  'createdAt', 'roles']);

const pageMeta = object({ total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' } },
  ['total', 'page', 'pageSize']);

export const userResponse = successSchema(user);
export const listResponse = successSchema({ type: 'array', items: user }, pageMeta);
export const createResponse = successSchema(object({ user, temporaryPassword: { type: 'string' } }, ['user', 'temporaryPassword']));
export const passwordResponse = successSchema(object({ temporaryPassword: { type: 'string' } }, ['temporaryPassword']));
export const revokeResponse = successSchema(object({ revoked: { type: 'integer' } }, ['revoked']));
export const reviewResponse = successSchema({
  type: 'array',
  items: object({
    id: { type: 'string' }, username: { type: 'string' }, displayName: { type: 'string' }, areaName: nullableString,
    lastLoginAt: nullableString, expiresAt: nullableString, exemptFromExpiry: { type: 'boolean' },
    isEmergency: { type: 'boolean' }, inactiveDays: { type: 'integer' },
  }, ['id', 'username', 'displayName', 'areaName', 'lastLoginAt', 'expiresAt', 'exemptFromExpiry', 'isEmergency', 'inactiveDays']),
}, pageMeta);
