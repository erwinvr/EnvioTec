import { createAuditLogsController } from './audit-logs.controller.js';
import { createAuditLogsRepository } from './audit-logs.repository.js';
import { exportQuery, exportResponse, listQuery, listResponse } from './audit-logs.schemas.js';
import { createAuditLogsService } from './audit-logs.service.js';

export async function auditLogsRoutes(app, { db, audit }) {
  const controller = createAuditLogsController(
    createAuditLogsService({ db, repository: createAuditLogsRepository(db), audit }),
  );

  app.get('/api/v1/audit-logs', {
    config: { permission: 'audit.view' },
    schema: { querystring: listQuery, response: { 200: listResponse } },
  }, controller.list);

  app.get('/api/v1/audit-logs/export', {
    config: { permission: 'audit.export' },
    schema: { querystring: exportQuery, response: { 200: exportResponse } },
  }, controller.export);
}
