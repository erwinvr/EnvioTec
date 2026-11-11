import { auditContext } from '../../core/audit/audit.service.js';
import { ok, successSchema } from '../../core/http/response.js';
import { createSuppressionsRepository } from './suppressions.repository.js';
import { createSuppressionsService } from './suppressions.service.js';
import { int, nullable, object } from '../../core/http/schema.js';

const email = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' };
const row = object({
  id: { type: 'string' }, email: nullable, emailHash: { type: 'string' }, reason: { type: 'string' }, source: { type: 'string' },
  note: nullable, createdBy: nullable, createdAt: { type: 'string' },
}, ['id', 'email', 'emailHash', 'reason', 'source', 'note', 'createdBy', 'createdAt']);

export async function suppressionsRoutes(app, { db, audit }) {
  const service = createSuppressionsService({ db, repository: createSuppressionsRepository(), audit });
  const manage = { permission: 'suppressions.manage' };

  app.get('/api/v1/suppressions', {
    config: { permission: 'suppressions.view' },
    schema: {
      querystring: object({
        page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        search: { type: 'string', minLength: 3, maxLength: 254 },
      }),
      response: { 200: successSchema({ type: 'array', items: row }, object({ total: int, page: int, pageSize: int }, ['total', 'page', 'pageSize'])) },
    },
  }, async (request) => {
    const { page, pageSize, search } = request.query;
    const { items, total } = await service.list(request, { page, pageSize, search });
    return ok(items, { total, page, pageSize });
  });

  app.post('/api/v1/suppressions', {
    config: manage,
    schema: { body: object({ email, note: { type: 'string', maxLength: 500 } }, ['email']), response: { 201: successSchema(object({ id: { type: 'string' } }, ['id'])) } },
  }, async (request, reply) => {
    reply.code(201);
    return ok(await service.add(request.auth, request.body, auditContext(request)));
  });

  app.delete('/api/v1/suppressions/:id', {
    config: manage,
    schema: { params: object({ id: { type: 'string', format: 'uuid' } }, ['id']), response: { 200: successSchema(object({})) } },
  }, async (request) => {
    await service.remove(request.auth, request.params.id, auditContext(request));
    return ok({});
  });

  app.post('/api/v1/suppressions/anonymize', {
    config: manage,
    schema: { body: object({ email }, ['email']), response: { 200: successSchema(object({ contacts: int, emailHash: { type: 'string' } }, ['contacts', 'emailHash'])) } },
  }, async (request) => ok(await service.anonymize(request.auth, request.body, auditContext(request))));
}
