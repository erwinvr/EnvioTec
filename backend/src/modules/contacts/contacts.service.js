import { basename } from 'node:path';
import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor } from '../../core/authorization/area-scope.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, NotFoundError, ValidationError } from '../../core/errors/errors.js';
import { FileTooLargeError } from '../../core/files/storage.js';
import { cleanValue, FIXED_COLUMNS, LIMITS } from './csv-rows.js';

// Contact lists and contacts (Parte B, ADR-008). Lists belong to an area and
// declare their attributes; contacts are unique per list by email. CSV
// imports are inspected in the isolated file-processor (ADR-004) and loaded
// by the worker; this service only stores the upload and queues it.

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const toList = (row) => ({
  id: row.id, areaId: row.area_id, areaName: row.area_name, name: row.name, description: row.description,
  attributes: row.attributes, contactCount: row.contact_count,
});
export const toContact = (row) => ({
  id: row.id, listId: row.list_id, email: row.email, firstName: row.first_name, lastName: row.last_name,
  attributes: row.attributes, anonymized: row.anonymized_at !== null, suppressed: row.suppressed ?? false,
});
export const toImport = (row) => ({
  id: row.id, listId: row.list_id, originalName: row.original_name, sizeBytes: row.size_bytes, sha256: row.sha256,
  status: row.status, totalRows: row.total_rows, inserted: row.inserted, updated: row.updated, rejected: row.rejected,
  errors: row.errors, failureReason: row.failure_reason, createdBy: row.created_by_username,
  createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
});

// Manual contact: same rules as a CSV row; attributes only those of the list.
export function normalizeContact({ email, firstName, lastName, attributes = {} }, listAttributes) {
  const problems = [];
  const contact = {
    email: cleanValue(email).toLowerCase(),
    first_name: cleanValue(firstName) || null,
    last_name: cleanValue(lastName) || null,
    attributes: {},
  };
  if (!EMAIL.test(contact.email) || contact.email.length > 254) problems.push({ field: 'email', code: 'invalid_email' });
  for (const [name, value] of Object.entries(attributes)) {
    if (!listAttributes.includes(name)) problems.push({ field: `attributes.${name}`, code: 'unknown_attribute' });
    else if (cleanValue(value).length > LIMITS.maxValue) problems.push({ field: `attributes.${name}`, code: 'too_long' });
    else if (cleanValue(value) !== '') contact.attributes[name] = cleanValue(value);
  }
  if (problems.length > 0) throw new ValidationError(problems);
  return contact;
}

// email, first_name and last_name are fields of every contact, never attributes.
export function assertAttributes(attributes = []) {
  const reserved = attributes.filter((name) => FIXED_COLUMNS.includes(name));
  if (reserved.length > 0) throw new ValidationError(reserved.map(() => ({ field: 'attributes', code: 'reserved_attribute' })));
}

export function safeFileName(name) {
  const clean = [...basename(String(name ?? ''))].filter((char) => char.codePointAt(0) >= 32 && char !== '\u007f').join('').trim();
  return (clean || 'archivo').slice(0, 255);
}

export function createContactsService({ db, repository, audit, store, fileQueue }) {
  const record = (client, auth, context, action, resourceType, id, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType, resourceId: id, result: 'success', context, metadata,
  });

  async function listInScope(client, auth, id, options) {
    const row = await repository.list(client, areaScopeFor(auth), id, options);
    if (!row) throw new NotFoundError();
    return row;
  }

  return {
    listInScope,

    async lists(auth) {
      return (await repository.lists(db, areaScopeFor(auth))).map(toList);
    },

    async createList(auth, input, context) {
      assertAttributes(input.attributes);
      const scope = areaScopeFor(auth);
      const areaId = input.areaId ?? auth.user.areaId;
      return withTransaction(db, async (client) => {
        const area = areaId ? await repository.findArea(client, areaId) : null;
        if (!area || !area.is_active || (!scope?.all && scope?.areaId !== areaId)) {
          throw new ValidationError([{ field: 'areaId', code: 'invalid_area' }]);
        }
        const id = await repository.createList(client, { ...input, areaId, actorId: auth.user.id });
        await record(client, auth, context, 'list.create', 'contact_list', id, { name: input.name, attributes: input.attributes ?? [] });
        return toList(await repository.list(client, { all: true }, id));
      });
    },

    async updateList(auth, id, changes, context) {
      assertAttributes(changes.attributes);
      return withTransaction(db, async (client) => {
        const before = await listInScope(client, auth, id, { forUpdate: true });
        await repository.updateList(client, id, changes, auth.user.id);
        const after = await repository.list(client, { all: true }, id);
        await record(client, auth, context, 'list.update', 'contact_list', id, {
          before: { name: before.name, description: before.description, attributes: before.attributes },
          after: { name: after.name, description: after.description, attributes: after.attributes },
        });
        return toList(after);
      });
    },

    async contacts(auth, listId, { search, page, pageSize }) {
      await listInScope(db, auth, listId);
      const { rows, total } = await repository.contacts(db, listId, { search, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: rows.map(toContact), total };
    },

    async createContact(auth, listId, input, context) {
      return withTransaction(db, async (client) => {
        const list = await listInScope(client, auth, listId);
        const contact = normalizeContact(input, list.attributes);
        const id = await repository.createContact(client, { areaId: list.area_id, listId, contact, actorId: auth.user.id });
        await record(client, auth, context, 'contact.create', 'contact', id, { listId });
        return toContact(await repository.contactInScope(client, { all: true }, id));
      });
    },

    async updateContact(auth, id, input, context) {
      return withTransaction(db, async (client) => {
        const before = await repository.contactInScope(client, areaScopeFor(auth), id, { forUpdate: true });
        if (!before) throw new NotFoundError();
        if (before.anonymized_at) throw new AppError('El contacto fue anonimizado', { statusCode: 409, code: 'CONFLICT' });
        const contact = normalizeContact({
          email: input.email ?? before.email, firstName: 'firstName' in input ? input.firstName : before.first_name,
          lastName: 'lastName' in input ? input.lastName : before.last_name, attributes: input.attributes ?? before.attributes,
        }, before.list_attributes);
        await repository.updateContact(client, id, contact);
        // Personal data stays out of the audit: only which fields changed.
        await record(client, auth, context, 'contact.update', 'contact', id, { listId: before.list_id, fields: Object.keys(input) });
        return toContact(await repository.contactInScope(client, { all: true }, id));
      });
    },

    async deleteContact(auth, id, context) {
      await withTransaction(db, async (client) => {
        const contact = await repository.contactInScope(client, areaScopeFor(auth), id, { forUpdate: true });
        if (!contact) throw new NotFoundError();
        await repository.deleteContact(client, id);
        await record(client, auth, context, 'contact.delete', 'contact', id, { listId: contact.list_id });
      });
    },

    // Stores the upload in quarantine and queues it for inspection.
    async startImport(auth, listId, file, context) {
      const list = await listInScope(db, auth, listId);
      if (!file) throw new ValidationError([{ field: 'file', code: 'required' }]);
      const originalName = safeFileName(file.filename);
      if (!originalName.toLowerCase().endsWith('.csv')) {
        file.file.resume();
        throw new ValidationError([{ field: 'file', code: 'not_csv' }], 'Solo se aceptan archivos .csv');
      }
      let saved;
      try {
        saved = await store.saveIncoming(file.file, { maxBytes: LIMITS.maxBytes });
      } catch (error) {
        if (error instanceof FileTooLargeError) throw new AppError('El archivo supera 10 MB', { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
        throw error;
      }
      const id = await withTransaction(db, async (client) => {
        const importId = await repository.createImport(client, { areaId: list.area_id, listId, file: saved, originalName, actorId: auth.user.id });
        await record(client, auth, context, 'contacts.import_request', 'contact_import', importId, {
          listId, originalName, sizeBytes: saved.size, sha256: saved.sha256,
        });
        return importId;
      });
      try {
        await fileQueue.add('contacts_csv', { kind: 'contacts_csv', fileId: saved.id, importId: id, attributes: list.attributes },
          { jobId: saved.id });
      } catch (error) {
        await repository.finishImport(db, id, { status: 'failed', failureReason: 'queue_unavailable' });
        await store.remove('incoming', saved.id);
        throw error;
      }
      return toImport(await repository.importInScope(db, { all: true }, id));
    },

    async imports(auth, listId) {
      await listInScope(db, auth, listId);
      return (await repository.imports(db, listId)).map(toImport);
    },

    async getImport(auth, id) {
      const row = await repository.importInScope(db, areaScopeFor(auth), id);
      if (!row) throw new NotFoundError();
      return toImport(row);
    },

    // Rows for the CSV export; the export itself is audited.
    async exportList(auth, listId, context) {
      const list = await listInScope(db, auth, listId);
      await record(db, auth, context, 'contacts.export', 'contact_list', listId, { contacts: list.contact_count });
      return { list, batches: repository.exportRows(db, listId) };
    },
  };
}
