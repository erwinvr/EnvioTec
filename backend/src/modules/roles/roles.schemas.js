import { successSchema } from '../../core/http/response.js';
import { idParams, object } from '../../core/http/schema.js';

const name = { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,49}$' };
const description = { type: 'string', maxLength: 500 };
const permissions = {
  type: 'array', maxItems: 200, items: { type: 'string', pattern: '^[a-z][a-z_]*\\.[a-z][a-z_]*$' },
};

export const createBody = object({ name, description, permissions }, ['name']);
export const updateBody = object({ name, description }, [], { minProperties: 1 });
export const permissionsBody = object({ permissions }, ['permissions']);

const role = object({
  id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, isSystem: { type: 'boolean' },
  administrative: { type: 'boolean' }, usedFromAd: { type: 'boolean' }, userCount: { type: 'integer' },
  permissions: { type: 'array', items: { type: 'string' } },
  adGroups: { type: 'array', items: object({ id: { type: 'string' }, groupDn: { type: 'string' } }, ['id', 'groupDn']) },
}, ['id', 'name', 'description', 'isSystem', 'administrative', 'usedFromAd', 'userCount', 'permissions']);

export const roleResponse = successSchema(role);
export const listResponse = successSchema({ type: 'array', items: role });
export const emptyResponse = successSchema(object({}));
export { idParams };
