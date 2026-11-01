import { auditContext } from '../../core/audit/audit.service.js';
import { ok, successSchema } from '../../core/http/response.js';
import { createSendersRepository } from './senders.repository.js';
import { createSendersService } from './senders.service.js';

const object = (properties, required = [], extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra });
const email = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' };
// No line breaks, angle brackets or quotes: the name goes into a mail header.
const displayName = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\r\\n<>"]+$' };
const sender = object({
  id: { type: 'string' }, areaId: { type: 'string' }, areaName: { type: 'string' }, email: { type: 'string' },
  displayName: { type: 'string' }, replyTo: { type: ['string', 'null'] }, isActive: { type: 'boolean' },
}, ['id', 'areaId', 'areaName', 'email', 'displayName', 'replyTo', 'isActive']);

export async function sendersRoutes(app, { db, audit }) {
  const service = createSendersService({ db, repository: createSendersRepository(), audit });

  app.get('/api/v1/senders', {
    config: { permission: 'campaigns.view' },
    schema: { response: { 200: successSchema({ type: 'array', items: sender }) } },
  }, async (request) => ok(await service.list(request)));

  app.post('/api/v1/senders', {
    config: { permission: 'senders.manage' },
    schema: {
      body: object({ areaId: { type: 'string', format: 'uuid' }, email, displayName, replyTo: { anyOf: [email, { type: 'null' }] } },
        ['areaId', 'email', 'displayName']),
      response: { 201: successSchema(sender) },
    },
  }, async (request, reply) => {
    reply.code(201);
    return ok(await service.create(request.auth, request.body, auditContext(request)));
  });

  app.patch('/api/v1/senders/:id', {
    config: { permission: 'senders.manage' },
    schema: {
      params: object({ id: { type: 'string', format: 'uuid' } }, ['id']),
      body: object({ displayName, replyTo: { anyOf: [email, { type: 'null' }] }, isActive: { type: 'boolean' } }, [], { minProperties: 1 }),
      response: { 200: successSchema(sender) },
    },
  }, async (request) => ok(await service.update(request.auth, request.params.id, request.body, auditContext(request))));
}
