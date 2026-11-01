import { auditContext } from '../../core/audit/audit.service.js';
import { ok } from '../../core/http/response.js';

export function createRolesController(service) {
  return {
    list: async () => ok(await service.list()),
    get: async (request) => ok(await service.get(request.params.id)),
    create: async (request, reply) => {
      reply.code(201);
      return ok(await service.create(request.auth, request.body, auditContext(request)));
    },
    update: async (request) => ok(await service.update(request.auth, request.params.id, request.body, auditContext(request))),
    replacePermissions: async (request) => ok(
      await service.replacePermissions(request.auth, request.params.id, request.body.permissions, auditContext(request)),
    ),
    remove: async (request) => {
      await service.remove(request.auth, request.params.id, auditContext(request));
      return ok({});
    },
  };
}
