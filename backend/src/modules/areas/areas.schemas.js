import { successSchema } from '../../core/http/response.js';
import { idParams } from '../../core/http/schema.js';

const name = { type: 'string', minLength: 2, maxLength: 100, pattern: '\\S' };
const adDepartment = { type: ['string', 'null'], minLength: 1, maxLength: 200 };

export const createBody = {
  type: 'object', additionalProperties: false, required: ['name'], properties: { name, adDepartment },
};
export const updateBody = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: { name, adDepartment, isActive: { type: 'boolean' } },
};
export { idParams };

const area = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'isActive'],
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, isActive: { type: 'boolean' }, adDepartment: { type: ['string', 'null'] },
  },
};

export const areaResponse = successSchema(area);
export const listResponse = successSchema({ type: 'array', items: area });
