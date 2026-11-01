import { Readable } from 'node:stream';
import { actorFrom } from '../../core/audit/audit.service.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { CSV_BOM, csvLine } from '../../core/http/csv.js';
import { ValidationError } from '../../core/errors/errors.js';

// Audit log query and export (A7). The log is global: it is not filtered by
// area, because only profiles with a global view (audit, administration)
// hold audit.view and audit.export.

export const MAX_OFFSET = 10000;
export const EXPORT_MAX_DAYS = 92;
export const EXPORT_MAX_ROWS = 100000;
const EXPORT_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const CSV_HEADER = ['fecha_utc', 'tipo_actor', 'id_actor', 'usuario_actor', 'accion', 'tipo_recurso', 'id_recurso',
  'resultado', 'ip', 'user_agent', 'request_id', 'metadata'];

function toItem(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    result: row.result,
    ip: row.ip,
    userAgent: row.user_agent,
    requestId: row.request_id,
    metadata: row.metadata,
  };
}

function assertRange(filters) {
  if (filters.from && filters.to && new Date(filters.from) >= new Date(filters.to)) {
    throw new ValidationError([{ field: 'to', code: 'before_from' }]);
  }
}

export function assertExportLimits(filters, rowCount) {
  assertRange(filters);
  if (new Date(filters.to) - new Date(filters.from) > EXPORT_MAX_DAYS * DAY_MS) {
    throw new ValidationError([{ field: 'to', code: 'range_too_long' }], `El rango no puede superar ${EXPORT_MAX_DAYS} días`);
  }
  if (rowCount > EXPORT_MAX_ROWS) {
    throw new ValidationError([{ field: 'from', code: 'too_many_rows' }],
      `La exportación supera ${EXPORT_MAX_ROWS} registros; acote el rango o los filtros`);
  }
}

export function createAuditLogsService({ db, repository, audit }) {
  return {
    async list(filters, { page, pageSize }) {
      assertRange(filters);
      const offset = (page - 1) * pageSize;
      if (offset > MAX_OFFSET) {
        throw new ValidationError([{ field: 'page', code: 'too_large' }], 'Página demasiado lejana; acote los filtros');
      }
      const [total, rows] = await Promise.all([repository.count(filters), repository.findPage(filters, { limit: pageSize, offset })]);
      return { items: rows.map(toItem), total };
    },

    // CSV streamed in batches. Requires a reauthentication from the last 5
    // minutes: the log holds users, IPs and actions of every area. The
    // export itself is audited (A7) before the first byte is sent.
    async exportCsv(auth, filters, context) {
      assertRecentReauth(auth);
      const total = await repository.count(filters);
      assertExportLimits(filters, total);
      await audit.record(db, {
        actor: actorFrom(auth), action: 'audit.export', resourceType: 'audit_logs', result: 'success', context,
        metadata: { filters, rows: total },
      });

      async function* lines() {
        yield CSV_BOM + csvLine(CSV_HEADER);
        let beforeSeq = Number.MAX_SAFE_INTEGER;
        let sent = 0;
        while (sent < total) {
          const rows = await repository.findBatch(db, filters, { beforeSeq, limit: EXPORT_BATCH });
          if (rows.length === 0) break;
          for (const row of rows) {
            const item = toItem(row);
            yield csvLine([item.occurredAt, item.actorType, item.actorUserId, item.actorUsername, item.action,
              item.resourceType, item.resourceId, item.result, item.ip, item.userAgent, item.requestId, item.metadata]);
          }
          sent += rows.length;
          beforeSeq = Number(rows.at(-1).seq);
        }
      }
      return { stream: Readable.from(lines()), total };
    },
  };
}
