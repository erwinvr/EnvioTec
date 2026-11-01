import { Readable } from 'node:stream';
import { auditContext } from '../../core/audit/audit.service.js';
import { CSV_BOM, csvLine } from '../../core/http/csv.js';
import { ok, successSchema } from '../../core/http/response.js';
import { createReportsRepository, EVENT_FILTERS, STATUS_FILTERS } from './reports.repository.js';
import { createReportsService, EXPORT_COLUMNS } from './reports.service.js';

const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const str = { type: 'string' };
const nullable = { type: ['string', 'null'] };
const STATS = ['recipients', 'accepted', 'rejected', 'suppressed', 'pending', 'notSent', 'delivered', 'opened', 'clicked', 'hardBounces', 'softBounces', 'complaints', 'unsubscribes'];
const stats = object(Object.fromEntries(STATS.map((key) => [key, int])), STATS);
const campaign = object({
  id: str, name: str, subject: str, status: str, areaId: str, areaName: str, startedAt: nullable, finishedAt: nullable, stats,
}, ['id', 'name', 'status', 'areaId', 'areaName', 'stats']);
const recipientProps = {
  id: str, email: str, status: str, sentAt: nullable, error: nullable, delivered: bool, opens: int, clicks: int,
  hardBounce: bool, softBounce: bool, complaint: bool, unsubscribed: bool, lastEventAt: nullable,
};
const recipient = object(recipientProps, ['id', 'email', 'status', 'delivered', 'opens', 'clicks']);
const contactRow = object({ ...recipientProps, campaignId: str, campaignName: str, areaName: str, startedAt: nullable }, ['id', 'email', 'status', 'campaignId', 'campaignName']);
const pageMeta = object({ total: int, page: int, pageSize: int }, ['total', 'page', 'pageSize']);
const paging = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } };
const idParams = object({ id: { type: 'string', format: 'uuid' } }, ['id']);
const date = { type: 'string', format: 'date' };

export async function reportsRoutes(app, { db, audit }) {
  const service = createReportsService({ db, repository: createReportsRepository(), audit });
  const route = (method, url, permission, schema, handler) => app.route({ method, url, config: { permission }, schema, handler });
  const paged = ({ items, total }, { page, pageSize }) => ok(items, { total, page, pageSize });

  route('GET', '/api/v1/reports/campaigns', 'reports.view', {
    querystring: object({ ...paging, search: { type: 'string', maxLength: 100 }, from: date, to: date }),
    response: { 200: successSchema({ type: 'array', items: campaign }, pageMeta) },
  }, async (r) => paged(await service.campaigns(r.auth, r.query), r.query));

  route('GET', '/api/v1/reports/campaigns/:id', 'reports.view', { params: idParams, response: { 200: successSchema(campaign) } },
    async (r) => ok(await service.campaign(r.auth, r.params.id)));

  route('GET', '/api/v1/reports/campaigns/:id/recipients', 'reports.view', {
    params: idParams,
    querystring: object({ ...paging, status: { type: 'string', enum: Object.keys(STATUS_FILTERS) }, event: { type: 'string', enum: Object.keys(EVENT_FILTERS) } }),
    response: { 200: successSchema({ type: 'array', items: recipient }, pageMeta) },
  }, async (r) => paged(await service.recipients(r.auth, r.params.id, r.query), r.query));

  // POST so the address travels in the body, never in the URL (access
  // logs, proxy logs, browser history).
  route('POST', '/api/v1/reports/contacts/search', 'reports.view', {
    querystring: object(paging),
    body: object({ email: { type: 'string', format: 'email', maxLength: 254 } }, ['email']),
    response: { 200: successSchema({ type: 'array', items: contactRow }, pageMeta) },
  }, async (r) => paged(await service.contact(r.auth, r.body, r.query, auditContext(r)), r.query));

  // CSV with formula neutralization (CSV injection); audited before sending.
  route('GET', '/api/v1/reports/campaigns/:id/export', 'reports.export', { params: idParams, response: { 200: { type: 'string' } } }, async (r, reply) => {
    const { campaign: c, rows } = await service.exportCampaign(r.auth, r.params.id, auditContext(r));
    async function* lines() {
      yield CSV_BOM + csvLine(EXPORT_COLUMNS);
      for await (const page of rows) for (const row of page) yield csvLine(row);
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="reporte-${c.id}.csv"`);
    return reply.send(Readable.from(lines()));
  });
}
