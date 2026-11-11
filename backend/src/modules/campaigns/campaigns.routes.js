import multipart from '@fastify/multipart';
import { auditContext } from '../../core/audit/audit.service.js';
import { ok, successSchema } from '../../core/http/response.js';
import { createQuotasRepository } from '../quotas/quotas.repository.js';
import { createQuotasService } from '../quotas/quotas.service.js';
import { createCampaignWorkflow } from './campaign-workflow.service.js';
import { createCampaignsRepository } from './campaigns.repository.js';
import { createCampaignsService } from './campaigns.service.js';
import { MAX_BYTES } from './pdf-rules.js';
import { idParams, int, nullable, object, pageMeta, paging, uuid } from '../../core/http/schema.js';

const ref = (extra = {}) => object({ id: { type: 'string' }, name: { type: 'string' }, ...extra }, ['id', 'name']);
const campaign = object({
  id: { type: 'string' }, areaId: { type: 'string' }, areaName: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' },
  subject: { type: 'string' }, scheduledAt: nullable,
  scheduleByDate: { anyOf: [{ type: 'null' }, object({ variable: { type: 'string' }, offsetDays: int, time: { type: 'string' } }, ['variable', 'offsetDays', 'time'])] },
  excluded: { anyOf: [{ type: 'null' }, object({ noDate: int, past: int, tooFar: int }, ['noDate', 'past', 'tooFar'])] },
  template: ref({ version: int, versionId: { type: 'string' } }), list: ref(),
  sender: object({ id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } }, ['id', 'email', 'name']),
  attachment: { anyOf: [{ type: 'null' }, object({ id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' }, failureReason: nullable }, ['id', 'name', 'status', 'failureReason'])] },
  createdBy: { type: 'string' }, submittedBy: nullable, submittedAt: nullable, approvedBy: nullable, approvedAt: nullable,
  rejectionReason: nullable, cancelReason: nullable, cancelledAt: nullable, startedAt: nullable, finishedAt: nullable,
  recipientCount: { type: ['integer', 'null'] }, reserved: int, createdAt: { type: 'string' },
}, ['id', 'areaId', 'name', 'status', 'subject', 'template', 'list', 'sender', 'attachment', 'createdBy', 'reserved']);
const name = { type: 'string', minLength: 2, maxLength: 150, pattern: '\\S' };
const subject = { type: 'string', minLength: 1, maxLength: 200 };
const reason = { type: 'string', minLength: 5, maxLength: 500, pattern: '\\S' };
// Sending by each contact's date (ADR-030): date variable, offset in days, time (HH:MM, America/La_Paz).
const scheduleByDate = {
  anyOf: [{ type: 'null' }, object({
    variable: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' }, offsetDays: { type: 'integer', minimum: -365, maximum: 365 },
    time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
  }, ['variable'])],
};
const editable = {
  name, subject, templateId: uuid, templateVersionId: uuid, listId: uuid, senderId: uuid, scheduledAt: { type: ['string', 'null'], format: 'date-time' }, scheduleByDate,
};

export async function campaignsRoutes(app, { db, audit, store, fileQueue, sendQueue }) {
  const repository = createCampaignsRepository();
  const quotas = createQuotasService({ db, repository: createQuotasRepository(), audit });
  const campaigns = createCampaignsService({ db, repository, audit, quotas, store, fileQueue });
  const workflow = createCampaignWorkflow({ db, repository, campaigns, audit, quotas, sendQueue });
  await app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 50 } });
  const route = (method, url, permission, schema, handler, extra = {}) => app.route({ method, url, config: { permission }, schema, handler, ...extra });
  const one = successSchema(campaign);
  const ctx = auditContext;
  const action = (method) => async (r) => ok(await method(r.auth, r.params.id, ctx(r)));

  route('GET', '/api/v1/campaigns', 'campaigns.view', {
    querystring: object({ ...paging, status: { type: 'string', enum: ['draft', 'submitted', 'approved', 'scheduled', 'sending', 'paused', 'completed', 'cancelled'] } }),
    response: { 200: successSchema({ type: 'array', items: campaign }, pageMeta) },
  }, async (r) => {
    const { page, pageSize, status } = r.query;
    const { items, total } = await campaigns.list(r.auth, { status, page, pageSize });
    return ok(items, { total, page, pageSize });
  });
  route('POST', '/api/v1/campaigns', 'campaigns.create', {
    body: object(editable, ['name', 'subject', 'templateId', 'listId', 'senderId']), response: { 201: one },
  }, async (r, reply) => {
    reply.code(201);
    return ok(await campaigns.create(r.auth, r.body, ctx(r)));
  });
  route('GET', '/api/v1/campaigns/:id', 'campaigns.view', { params: idParams, response: { 200: one } }, async (r) => ok(await campaigns.get(r.auth, r.params.id)));
  route('PATCH', '/api/v1/campaigns/:id', 'campaigns.update', { params: idParams, body: object(editable, [], { minProperties: 1 }), response: { 200: one } },
    async (r) => ok(await campaigns.update(r.auth, r.params.id, r.body, ctx(r))));
  route('DELETE', '/api/v1/campaigns/:id', 'campaigns.delete', { params: idParams, response: { 200: successSchema(object({})) } }, async (r) => {
    await campaigns.remove(r.auth, r.params.id, ctx(r));
    return ok({});
  });
  route('POST', '/api/v1/campaigns/:id/attachment', 'campaigns.update', { params: idParams, response: { 202: one } }, async (r, reply) => {
    const file = await r.file();
    reply.code(202);
    return ok(await campaigns.uploadAttachment(r.auth, r.params.id, file, ctx(r)));
  }, { bodyLimit: MAX_BYTES + 64 * 1024 });
  route('DELETE', '/api/v1/campaigns/:id/attachment', 'campaigns.update', { params: idParams, response: { 200: one } }, action(campaigns.removeAttachment));
  route('GET', '/api/v1/campaigns/:id/recipients', 'campaigns.view', {
    params: idParams, querystring: object(paging),
    response: {
      200: successSchema({
        type: 'array',
        items: object({ id: { type: 'string' }, email: { type: 'string' }, firstName: nullable, lastName: nullable, status: { type: 'string' }, sentAt: nullable, error: nullable, sendAt: nullable },
          ['id', 'email', 'firstName', 'lastName', 'status', 'sentAt', 'error']),
      }, pageMeta),
    },
  }, async (r) => {
    const { page, pageSize } = r.query;
    const { items, total } = await campaigns.recipients(r, r.params.id, { page, pageSize });
    return ok(items, { total, page, pageSize });
  });

  route('POST', '/api/v1/campaigns/:id/submit', 'campaigns.submit', { params: idParams, response: { 200: one } }, action(workflow.submit));
  route('POST', '/api/v1/campaigns/:id/approve', 'campaigns.approve', { params: idParams, response: { 200: one } }, action(workflow.approve));
  route('POST', '/api/v1/campaigns/:id/reject', 'campaigns.approve', { params: idParams, body: object({ reason }, ['reason']), response: { 200: one } },
    async (r) => ok(await workflow.reject(r.auth, r.params.id, r.body, ctx(r))));
  route('POST', '/api/v1/campaigns/:id/cancel', 'campaigns.cancel', { params: idParams, body: object({ reason }, ['reason']), response: { 200: one } },
    async (r) => ok(await workflow.cancel(r.auth, r.params.id, r.body, ctx(r))));
  route('POST', '/api/v1/campaigns/:id/pause', 'campaigns.pause', { params: idParams, response: { 200: one } }, action(workflow.pause));
  route('POST', '/api/v1/campaigns/:id/resume', 'campaigns.pause', { params: idParams, response: { 200: one } }, action(workflow.resume));
  route('POST', '/api/v1/campaigns/:id/test-send', 'campaigns.send_test', {
    params: idParams,
    body: object({ email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' } }, ['email']),
    response: { 202: successSchema(object({ id: { type: 'string' }, status: { type: 'string' }, createdAt: { type: 'string' } }, ['id', 'status', 'createdAt'])) },
  }, async (r, reply) => {
    reply.code(202);
    return ok(await workflow.testSend(r.auth, r.params.id, r.body, ctx(r)));
  });
}
