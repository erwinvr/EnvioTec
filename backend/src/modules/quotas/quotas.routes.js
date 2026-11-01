import { auditContext } from '../../core/audit/audit.service.js';
import { ok, successSchema } from '../../core/http/response.js';
import { createQuotasRepository } from './quotas.repository.js';
import { createQuotasService } from './quotas.service.js';

const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const int = { type: 'integer' };
const quota = object({ assigned: int, reserved: int, consumed: int, available: int }, ['assigned', 'reserved', 'consumed', 'available']);
const nullable = { type: ['string', 'null'] };
const movement = object({
  id: { type: 'string' }, kind: { type: 'string' }, amount: int, assignedAfter: int, reservedAfter: int, consumedAfter: int,
  campaignId: nullable, reason: nullable, actorUsername: nullable, occurredAt: { type: 'string' },
}, ['id', 'kind', 'amount', 'assignedAfter', 'reservedAfter', 'consumedAfter', 'campaignId', 'reason', 'actorUsername', 'occurredAt']);
const paging = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};
const pageMeta = object({ total: int, page: int, pageSize: int }, ['total', 'page', 'pageSize']);
const detailResponse = successSchema(object({ quota, movements: { type: 'array', items: movement } }, ['quota', 'movements']), pageMeta);
const userParams = object({ userId: { type: 'string', format: 'uuid' } }, ['userId']);

export async function quotasRoutes(app, { db, audit }) {
  const service = createQuotasService({ db, repository: createQuotasRepository(), audit });
  const view = { permission: 'quotas.view' };
  const withMeta = ({ movements, quota: q, total }, { page, pageSize }) => ok({ quota: q, movements }, { total, page, pageSize });

  app.get('/api/v1/quotas/me', { config: view, schema: { querystring: object(paging), response: { 200: detailResponse } } },
    async (request) => withMeta(await service.mine(request.auth, request.query), request.query));

  app.get('/api/v1/quotas/global', {
    config: view,
    schema: { response: { 200: successSchema(object({ month: { type: 'string' }, sent: int, cap: int, remaining: int }, ['month', 'sent', 'cap', 'remaining'])) } },
  }, async () => ok(await service.globalUsage()));

  app.get('/api/v1/quotas', {
    config: view,
    schema: {
      querystring: object({ ...paging, search: { type: 'string', minLength: 1, maxLength: 100 } }),
      response: {
        200: successSchema({
          type: 'array',
          items: object({ userId: { type: 'string' }, username: { type: 'string' }, displayName: { type: 'string' }, areaName: nullable, ...quota.properties },
            ['userId', 'username', 'displayName', 'areaName', ...quota.required]),
        }, pageMeta),
      },
    },
  }, async (request) => {
    const { page, pageSize, search } = request.query;
    const { items, total } = await service.list(request.auth, { page, pageSize, search });
    return ok(items, { total, page, pageSize });
  });

  app.get('/api/v1/quotas/:userId/movements', {
    config: view, schema: { params: userParams, querystring: object(paging), response: { 200: detailResponse } },
  }, async (request) => withMeta(await service.detail(request.auth, request.params.userId, request.query), request.query));

  app.post('/api/v1/quotas/:userId/adjust', {
    config: { permission: 'quotas.manage' },
    schema: {
      params: userParams,
      body: object({
        delta: { type: 'integer', minimum: -10000000, maximum: 10000000, not: { const: 0 } },
        reason: { type: 'string', minLength: 10, maxLength: 500, pattern: '\\S' },
      }, ['delta', 'reason']),
      response: { 200: successSchema(quota) },
    },
  }, async (request) => ok(await service.adjust(request.auth, request.params.userId, request.body, auditContext(request))));
}
