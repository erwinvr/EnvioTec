import { auditContext } from '../../core/audit/audit.service.js';
import { ok, successSchema } from '../../core/http/response.js';
import { MAX_DN_LENGTH } from './dn.js';
import { createDirectoryRepository } from './directory.repository.js';
import { createDirectoryService } from './directory.service.js';

const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const mapping = object({ id: { type: 'string' }, groupDn: { type: 'string' }, roleId: { type: 'string' }, roleName: { type: 'string' } },
  ['id', 'groupDn', 'roleId', 'roleName']);

export async function directoryRoutes(app, { db, ad, audit }) {
  const service = createDirectoryService({ db, repository: createDirectoryRepository(), ad, audit });
  const config = { permission: 'directory.manage' };

  app.get('/api/v1/directory/mappings', {
    config, schema: { response: { 200: successSchema({ type: 'array', items: mapping }) } },
  }, async () => ok(await service.list()));

  app.post('/api/v1/directory/mappings', {
    config,
    schema: {
      body: object({ groupDn: { type: 'string', minLength: 3, maxLength: MAX_DN_LENGTH }, roleId: { type: 'string', format: 'uuid' } },
        ['groupDn', 'roleId']),
      response: { 201: successSchema(mapping) },
    },
  }, async (request, reply) => {
    reply.code(201);
    return ok(await service.create(request.auth, request.body, auditContext(request)));
  });

  app.delete('/api/v1/directory/mappings/:id', {
    config,
    schema: { params: object({ id: { type: 'string', format: 'uuid' } }, ['id']), response: { 200: successSchema(object({})) } },
  }, async (request) => {
    await service.remove(request.auth, request.params.id, auditContext(request));
    return ok({});
  });
}
