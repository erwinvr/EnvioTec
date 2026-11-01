import { auditContext } from '../../core/audit/audit.service.js';
import { ok } from '../../core/http/response.js';

export function createAreasController(service) {
  return {
    list: async (request) => ok(await service.list(request)),
    create: async (request, reply) => {
      reply.code(201);
      return ok(await service.create(request.auth, request.body, auditContext(request)));
    },
    update: async (request) => ok(await service.update(request.auth, request.params.id, request.body, auditContext(request))),
  };
}
