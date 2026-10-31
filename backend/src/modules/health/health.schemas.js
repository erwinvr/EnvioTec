import { successSchema } from '../../core/http/response.js';

export const liveResponse = successSchema({
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: { status: { type: 'string', enum: ['ok'] } },
});

export const readyResponse = successSchema({
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: { status: { type: 'string', enum: ['ready'] } },
});
