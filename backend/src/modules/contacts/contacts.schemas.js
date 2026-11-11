import { successSchema } from '../../core/http/response.js';

const object = (properties, required = [], extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra });
const uuid = { type: 'string', format: 'uuid' };
const nullable = { type: ['string', 'null'] };
const int = { type: 'integer' };
const nullableInt = { type: ['integer', 'null'] };
const attributeName = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' };
const attributeValues = { type: 'object', maxProperties: 30, additionalProperties: { type: 'string', maxLength: 500 } };
const paging = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};
export const pageMeta = object({ total: int, page: int, pageSize: int }, ['total', 'page', 'pageSize']);

export const idParams = object({ id: uuid }, ['id']);
export const createListBody = object({
  areaId: uuid,
  name: { type: 'string', minLength: 2, maxLength: 100, pattern: '\\S' },
  description: { type: 'string', maxLength: 500 },
  attributes: { type: 'array', maxItems: 30, uniqueItems: true, items: attributeName },
  variables: { type: 'array', maxItems: 30, items: object({ name: attributeName, label: { type: 'string', minLength: 1, maxLength: 60 }, type: { type: 'string', enum: ['text', 'date'] } }, ['label']) },
}, ['name']);
export const updateListBody = object({
  name: createListBody.properties.name, description: createListBody.properties.description,
}, [], { minProperties: 1 });
// Variables of a list (ADR-028).
export const variableParams = object({ id: uuid, name: attributeName }, ['id', 'name']);
export const variableBody = object({ name: attributeName, label: { type: 'string', minLength: 1, maxLength: 60 }, type: { type: 'string', enum: ['text', 'date'] } }, ['label']);
export const variableLabelBody = object({ label: { type: 'string', minLength: 1, maxLength: 60 } }, ['label']);
// One target per CSV column: a fixed field, a variable, or null (skip).
export const mappingBody = object({
  mapping: { type: 'array', minItems: 1, maxItems: 50, items: { anyOf: [{ type: 'null' }, attributeName] } },
}, ['mapping']);
export const contactsQuery = object({ ...paging, search: { type: 'string', minLength: 1, maxLength: 100 } });
export const createContactBody = object({
  email: { type: 'string', minLength: 3, maxLength: 254 },
  firstName: { type: ['string', 'null'], maxLength: 100 },
  lastName: { type: ['string', 'null'], maxLength: 100 },
  attributes: attributeValues,
}, ['email']);
export const updateContactBody = object(createContactBody.properties, [], { minProperties: 1 });

const list = object({
  id: { type: 'string' }, areaId: { type: 'string' }, areaName: { type: 'string' }, name: { type: 'string' },
  description: { type: 'string' }, attributes: { type: 'array', items: { type: 'string' } }, contactCount: int,
  variables: { type: 'array', items: object({ name: { type: 'string' }, label: { type: 'string' }, type: { type: 'string' } }, ['name', 'label', 'type']) },
}, ['id', 'areaId', 'areaName', 'name', 'description', 'attributes', 'contactCount', 'variables']);
const contact = object({
  id: { type: 'string' }, listId: { type: 'string' }, email: { type: 'string' }, firstName: nullable, lastName: nullable,
  attributes: { type: 'object', additionalProperties: { type: 'string' } }, anonymized: { type: 'boolean' }, suppressed: { type: 'boolean' },
}, ['id', 'listId', 'email', 'firstName', 'lastName', 'attributes', 'anonymized', 'suppressed']);
const importRow = object({
  id: { type: 'string' }, listId: { type: 'string' }, originalName: { type: 'string' }, sizeBytes: int, sha256: { type: 'string' },
  status: { type: 'string' }, totalRows: nullableInt, inserted: nullableInt, updated: nullableInt, rejected: nullableInt,
  errors: { type: 'array', items: object({ row: int, field: { type: 'string' }, code: { type: 'string' } }) },
  failureReason: nullable, createdBy: { type: 'string' }, createdAt: { type: 'string' }, finishedAt: nullable,
  header: { type: ['array', 'null'], items: { type: 'string' } },
  sample: { type: ['array', 'null'], items: { type: 'array', items: { type: 'string' } } },
  mapping: { type: ['array', 'null'], items: { type: ['string', 'null'] } },
}, ['id', 'listId', 'originalName', 'sizeBytes', 'sha256', 'status', 'totalRows', 'inserted', 'updated', 'rejected', 'errors',
  'failureReason', 'createdBy', 'createdAt', 'finishedAt']);

export const listResponse = successSchema(list);
export const listsResponse = successSchema({ type: 'array', items: list });
export const contactResponse = successSchema(contact);
export const contactsResponse = successSchema({ type: 'array', items: contact }, pageMeta);
export const importResponse = successSchema(importRow);
export const importsResponse = successSchema({ type: 'array', items: importRow });
export const emptyResponse = successSchema(object({}));
