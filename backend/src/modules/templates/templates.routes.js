import multipart from '@fastify/multipart';
import { auditContext } from '../../core/audit/audit.service.js';
import { ok, successSchema } from '../../core/http/response.js';
import { LIMITS } from './template-rules.js';
import { createTemplatesRepository } from './templates.repository.js';
import { createTemplatesService, toVersion } from './templates.service.js';
import { idParams, int, nullable, object } from '../../core/http/schema.js';

const version = object({
  id: { type: 'string' }, version: int, status: { type: 'string' }, originalName: { type: 'string' }, sizeBytes: int,
  sha256: { type: 'string' }, variables: { type: 'array', items: { type: 'string' } }, images: int, failureReason: nullable,
  createdBy: { type: 'string' }, createdAt: { type: 'string' }, processedAt: nullable,
}, ['id', 'version', 'status', 'originalName', 'sizeBytes', 'sha256', 'variables', 'images', 'failureReason', 'createdBy', 'createdAt', 'processedAt']);
const template = object({
  id: { type: 'string' }, areaId: { type: 'string' }, areaName: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
  isArchived: { type: 'boolean' }, latestReadyVersion: { type: ['integer', 'null'] }, versions: { type: 'array', items: version },
}, ['id', 'areaId', 'areaName', 'name', 'description', 'isArchived', 'latestReadyVersion']);
const versionParams = object({ id: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 } }, ['id', 'version']);
const name = { type: 'string', minLength: 2, maxLength: 100, pattern: '\\S' };

// Headers of the isolated preview (ADR-012): its own CSP with sandbox and no
// scripts; nginx serves this path with these headers only.
export const PREVIEW_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'";

export async function templatesRoutes(app, { db, audit, store, fileQueue }) {
  const service = createTemplatesService({ db, repository: createTemplatesRepository(), audit, store, fileQueue });
  await app.register(multipart, { limits: { fileSize: LIMITS.maxBytes, files: 1, fields: 0, parts: 1, headerPairs: 50 } });
  const route = (method, url, permission, schema, handler, extra = {}) => app.route({ method, url, config: { permission }, schema, handler, ...extra });
  const ctx = auditContext;

  route('GET', '/api/v1/templates', 'templates.view', {
    querystring: object({ includeArchived: { type: 'boolean', default: false } }),
    response: { 200: successSchema({ type: 'array', items: template }) },
  }, async (r) => ok(await service.list(r.auth, r.query)));
  route('POST', '/api/v1/templates', 'templates.create', {
    body: object({ areaId: { type: 'string', format: 'uuid' }, name, description: { type: 'string', maxLength: 500 } }, ['name']),
    response: { 201: successSchema(template) },
  }, async (r, reply) => {
    reply.code(201);
    return ok(await service.create(r.auth, r.body, ctx(r)));
  });
  route('GET', '/api/v1/templates/:id', 'templates.view', { params: idParams, response: { 200: successSchema(template) } },
    async (r) => ok(await service.get(r.auth, r.params.id)));
  route('PATCH', '/api/v1/templates/:id', 'templates.update', {
    params: idParams,
    body: object({ name, description: { type: 'string', maxLength: 500 }, isArchived: { type: 'boolean' } }, [], { minProperties: 1 }),
    response: { 200: successSchema(template) },
  }, async (r) => ok(await service.update(r.auth, r.params.id, r.body, ctx(r))));
  route('DELETE', '/api/v1/templates/:id', 'templates.delete', { params: idParams, response: { 200: successSchema(template) } },
    async (r) => ok(await service.update(r.auth, r.params.id, { isArchived: true }, ctx(r))));
  route('POST', '/api/v1/templates/:id/versions', 'templates.update', { params: idParams, response: { 202: successSchema(version) } },
    async (r, reply) => {
      const file = await r.file();
      reply.code(202);
      return ok(await service.uploadVersion(r.auth, r.params.id, file, ctx(r)));
    }, { bodyLimit: LIMITS.maxBytes + 64 * 1024 });
  route('GET', '/api/v1/templates/:id/versions/:version', 'templates.view', {
    params: versionParams,
    response: { 200: successSchema(object({ ...version.properties, text: nullable }, version.required)) },
  }, async (r) => {
    const row = await service.version(r.auth, r.params.id, r.params.version);
    return ok({ ...toVersion(row), text: row.text_body });
  });
  route('GET', '/api/v1/templates/:id/versions/:version/preview', 'templates.view', {
    params: versionParams, response: { 200: { type: 'string' } },
  }, async (r, reply) => {
    const html = await service.previewHtml(r.auth, r.params.id, r.params.version);
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', PREVIEW_CSP)
      .header('x-content-type-options', 'nosniff');
    return html;
  });
}
