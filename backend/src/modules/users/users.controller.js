import { auditContext } from '../../core/audit/audit.service.js';
import { ok } from '../../core/http/response.js';

const FILTERS = ['search', 'status', 'authSource', 'areaId', 'roleId'];
const pick = (query, keys) => Object.fromEntries(keys.filter((key) => query[key] !== undefined).map((key) => [key, query[key]]));

export function createUsersController({ users, roles }) {
  const ctx = auditContext;
  return {
    list: async (request) => {
      const { page, pageSize, sort, direction } = request.query;
      const { items, total } = await users.list(request.auth, pick(request.query, FILTERS), { page, pageSize, sort, direction });
      return ok(items, { total, page, pageSize });
    },
    get: async (request) => ok(await users.get(request.auth, request.params.id)),
    effectivePermissions: async (request) => ok(await users.effectivePermissions(request.auth, request.params.id)),
    reviewLocal: async (request) => {
      const { page, pageSize } = request.query;
      const { items, total } = await users.reviewLocal(request.auth, { page, pageSize });
      return ok(items, { total, page, pageSize });
    },
    create: async (request, reply) => {
      reply.code(201);
      return ok(await users.createLocal(request.auth, request.body, ctx(request)));
    },
    update: async (request) => ok(await users.update(request.auth, request.params.id, request.body, ctx(request))),
    disable: async (request) => ok(await users.disable(request.auth, request.params.id, ctx(request))),
    enable: async (request) => ok(await users.enable(request.auth, request.params.id, ctx(request))),
    unlock: async (request) => ok(await users.unlock(request.auth, request.params.id, ctx(request))),
    resetPassword: async (request) => ok(await users.resetPassword(request.auth, request.params.id, ctx(request))),
    renew: async (request) => ok(await users.renew(request.auth, request.params.id, request.body, ctx(request))),
    replaceRoles: async (request) => ok(await roles.replace(request.auth, request.params.id, request.body.roleIds, ctx(request))),
    listSessions: async (request) => ok(await users.listSessions(request.auth, request.params.id)),
    revokeSessions: async (request) => ok(await users.revokeSessions(request.auth, request.params.id, ctx(request))),
  };
}
