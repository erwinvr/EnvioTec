import { auditContext } from '../../core/audit/audit.service.js';
import { ok, successSchema } from '../../core/http/response.js';
import { createSettingsRepository } from './settings.repository.js';
import { createSettingsService } from './settings.service.js';

const setting = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'type', 'value', 'min', 'max', 'description', 'updatedAt'],
  properties: {
    key: { type: 'string' },
    type: { type: 'string' },
    value: { anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'string' } }] },
    min: { type: ['integer', 'null'] },
    max: { type: ['integer', 'null'] },
    description: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export async function settingsRoutes(app, { db, audit }) {
  const service = createSettingsService({ db, repository: createSettingsRepository(), audit });
  const config = { permission: 'settings.manage' };

  app.get('/api/v1/settings', {
    config, schema: { response: { 200: successSchema({ type: 'array', items: setting }) } },
  }, async () => ok(await service.list()));

  app.patch('/api/v1/settings/:key', {
    config,
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['key'],
        properties: { key: { type: 'string', pattern: '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$', maxLength: 100 } },
      },
      body: {
        type: 'object', additionalProperties: false, required: ['value'],
        properties: { value: { anyOf: [{ type: 'integer' }, { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 254 } }] } },
      },
      response: { 200: successSchema(setting) },
    },
  }, async (request) => ok(await service.update(request.auth, request.params.key, request.body.value, auditContext(request))));
}
