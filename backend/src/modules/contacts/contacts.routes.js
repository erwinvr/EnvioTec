import { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import { auditContext } from '../../core/audit/audit.service.js';
import { CSV_BOM, csvLine } from '../../core/http/csv.js';
import { ok } from '../../core/http/response.js';
import { LIMITS } from './csv-rows.js';
import { formatDate, isDateVariable } from './dates.js';
import { createContactsRepository } from './contacts.repository.js';
import * as s from './contacts.schemas.js';
import { createContactsService, toList } from './contacts.service.js';
import { createImportsService } from './imports.service.js';
import { createVariablesService } from './variables.service.js';

export async function contactsRoutes(app, { db, audit, store, fileQueue }) {
  const repository = createContactsRepository();
  const service = createContactsService({ db, repository, audit });
  const variables = createVariablesService({ db, repository, audit });
  const imports = createImportsService({ db, repository, audit, store, fileQueue });
  // Multipart only in this plugin, with one file and nothing else (A8, ADR-004).
  await app.register(multipart, { limits: { fileSize: LIMITS.maxBytes, files: 1, fields: 0, parts: 1, headerPairs: 50 } });
  const route = (method, url, permission, schema, handler, extra = {}) => app.route({ method, url, config: { permission }, schema, handler, ...extra });
  const byId = (extra) => ({ params: s.idParams, ...extra });
  const ctx = auditContext;

  route('GET', '/api/v1/lists', 'contacts.view', { response: { 200: s.listsResponse } }, async (r) => ok(await service.lists(r.auth)));
  route('POST', '/api/v1/lists', 'contacts.create', { body: s.createListBody, response: { 201: s.listResponse } }, async (r, reply) => {
    reply.code(201);
    return ok(await service.createList(r.auth, r.body, ctx(r)));
  });
  route('GET', '/api/v1/lists/:id', 'contacts.view', byId({ response: { 200: s.listResponse } }),
    async (r) => ok(toList(await service.listInScope(db, r.auth, r.params.id))));
  route('PATCH', '/api/v1/lists/:id', 'contacts.update', byId({ body: s.updateListBody, response: { 200: s.listResponse } }),
    async (r) => ok(await service.updateList(r.auth, r.params.id, r.body, ctx(r))));

  route('GET', '/api/v1/lists/:id/contacts', 'contacts.view', byId({ querystring: s.contactsQuery, response: { 200: s.contactsResponse } }),
    async (r) => {
      const { page, pageSize, search } = r.query;
      const { items, total } = await service.contacts(r.auth, r.params.id, { page, pageSize, search });
      return ok(items, { total, page, pageSize });
    });
  route('POST', '/api/v1/lists/:id/contacts', 'contacts.create', byId({ body: s.createContactBody, response: { 201: s.contactResponse } }),
    async (r, reply) => {
      reply.code(201);
      return ok(await service.createContact(r.auth, r.params.id, r.body, ctx(r)));
    });
  route('PATCH', '/api/v1/contacts/:id', 'contacts.update', byId({ body: s.updateContactBody, response: { 200: s.contactResponse } }),
    async (r) => ok(await service.updateContact(r.auth, r.params.id, r.body, ctx(r))));
  route('DELETE', '/api/v1/contacts/:id', 'contacts.delete', byId({ response: { 200: s.emptyResponse } }), async (r) => {
    await service.deleteContact(r.auth, r.params.id, ctx(r));
    return ok({});
  });

  route('POST', '/api/v1/lists/:id/imports', 'contacts.import', byId({ response: { 202: s.importResponse } }), async (r, reply) => {
    const file = await r.file();
    reply.code(202);
    return ok(await imports.start(r.auth, r.params.id, file, ctx(r)));
  }, { bodyLimit: LIMITS.maxBytes + 64 * 1024 });
  route('GET', '/api/v1/lists/:id/imports', 'contacts.view', byId({ response: { 200: s.importsResponse } }),
    async (r) => ok(await imports.list(r.auth, r.params.id)));
  route('GET', '/api/v1/imports/:id', 'contacts.view', byId({ response: { 200: s.importResponse } }),
    async (r) => ok(await imports.get(r.auth, r.params.id)));
  route('POST', '/api/v1/imports/:id/mapping', 'contacts.import', byId({ body: s.mappingBody, response: { 200: s.importResponse } }),
    async (r) => ok(await imports.map(r.auth, r.params.id, r.body, ctx(r))));
  route('DELETE', '/api/v1/imports/:id', 'contacts.import', byId({ response: { 200: s.importResponse } }),
    async (r) => ok(await imports.cancel(r.auth, r.params.id, ctx(r))));

  // Variables of a list (ADR-028).
  route('POST', '/api/v1/lists/:id/variables', 'contacts.update', byId({ body: s.variableBody, response: { 201: s.listResponse } }),
    async (r, reply) => {
      reply.code(201);
      return ok(toList(await variables.add(r.auth, r.params.id, r.body, ctx(r))));
    });
  route('PATCH', '/api/v1/lists/:id/variables/:name', 'contacts.update', { params: s.variableParams, body: s.variableLabelBody, response: { 200: s.listResponse } },
    async (r) => ok(toList(await variables.relabel(r.auth, r.params.id, r.params.name, r.body, ctx(r)))));
  route('DELETE', '/api/v1/lists/:id/variables/:name', 'contacts.update', { params: s.variableParams, response: { 200: s.listResponse } },
    async (r) => ok(toList(await variables.remove(r.auth, r.params.id, r.params.name, ctx(r)))));

  // CSV with formula neutralization (CSV injection); audited before sending.
  route('GET', '/api/v1/lists/:id/export', 'contacts.export', byId({ response: { 200: { type: 'string' } } }), async (r, reply) => {
    const { list, batches } = await service.exportList(r.auth, r.params.id, ctx(r));
    async function* lines() {
      yield CSV_BOM + csvLine(['email', 'first_name', 'last_name', ...list.attributes]);
      for await (const rows of batches) {
        // Date variables as DD/MM/AAAA, the format they are imported in (ADR-030).
        for (const row of rows) yield csvLine([row.email, row.first_name, row.last_name, ...list.attributes.map((a) => (isDateVariable(list.attribute_types, a) ? formatDate(row.attributes[a] ?? '') : row.attributes[a] ?? ''))]);
      }
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="contactos-${list.id}.csv"`);
    return reply.send(Readable.from(lines()));
  });
}
