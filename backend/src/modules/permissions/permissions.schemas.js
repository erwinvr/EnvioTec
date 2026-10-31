import { successSchema } from '../../core/http/response.js';

export const listResponse = successSchema(
  {
    type: 'array',
    items: {
      type: 'object',
      required: ['code', 'description', 'administrative'],
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        description: { type: 'string' },
        administrative: { type: 'boolean' },
      },
    },
  },
  {
    type: 'object',
    required: ['total'],
    additionalProperties: false,
    properties: { total: { type: 'integer' } },
  },
);
