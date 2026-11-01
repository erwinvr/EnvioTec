import { successSchema } from '../../core/http/response.js';

const filterProperties = {
  from: { type: 'string', format: 'date-time' },
  to: { type: 'string', format: 'date-time' },
  actorUserId: { type: 'string', format: 'uuid' },
  action: { type: 'string', pattern: '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$', maxLength: 100 },
  resourceType: { type: 'string', pattern: '^[a-z][a-z_]*$', maxLength: 50 },
  resourceId: { type: 'string', minLength: 1, maxLength: 100 },
  result: { type: 'string', enum: ['success', 'denied', 'failure'] },
  requestId: { type: 'string', minLength: 1, maxLength: 64 },
};

export const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...filterProperties,
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
};

// Exports always need a date range (at most 92 days).
export const exportQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: filterProperties,
};

const nullableString = { type: ['string', 'null'] };

export const listResponse = successSchema(
  {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'occurredAt', 'actorType', 'actorUserId', 'actorUsername', 'action', 'resourceType',
        'resourceId', 'result', 'ip', 'userAgent', 'requestId', 'metadata'],
      properties: {
        id: { type: 'string' },
        occurredAt: { type: 'string' },
        actorType: { type: 'string' },
        actorUserId: nullableString,
        actorUsername: nullableString,
        action: { type: 'string' },
        resourceType: nullableString,
        resourceId: nullableString,
        result: { type: 'string' },
        ip: nullableString,
        userAgent: nullableString,
        requestId: nullableString,
        // Free-form, but written only by the audit service without sensitive fields.
        metadata: { type: 'object', additionalProperties: true },
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['total', 'page', 'pageSize'],
    properties: { total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' } },
  },
);

export const exportResponse = { type: 'string' };
