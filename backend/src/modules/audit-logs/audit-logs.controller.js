import { auditContext } from '../../core/audit/audit.service.js';
import { ok } from '../../core/http/response.js';

const FILTERS = ['from', 'to', 'actorUserId', 'action', 'resourceType', 'resourceId', 'result', 'requestId'];
const filtersFrom = (query) => Object.fromEntries(FILTERS.filter((key) => query[key] !== undefined).map((key) => [key, query[key]]));
// from and to are validated as date-time, so the file name only holds digits.
const day = (iso) => iso.slice(0, 10).replaceAll('-', '');

export function createAuditLogsController(service) {
  return {
    list: async (request) => {
      const { page, pageSize } = request.query;
      const { items, total } = await service.list(filtersFrom(request.query), { page, pageSize });
      return ok(items, { total, page, pageSize });
    },

    export: async (request, reply) => {
      const filters = filtersFrom(request.query);
      const { stream } = await service.exportCsv(request.auth, filters, auditContext(request));
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="auditoria-${day(filters.from)}-${day(filters.to)}.csv"`);
      return reply.send(stream);
    },
  };
}
