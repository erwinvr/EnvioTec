import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor, findForWrite } from '../../core/authorization/area-scope.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../core/errors/errors.js';
import { FileTooLargeError } from '../../core/files/storage.js';
import { LIMITS, validateMapping } from './csv-rows.js';
import { safeFileName } from './contacts.service.js';

// CSV imports in two steps (ADR-004, ADR-028):
//   1. upload: the file is stored in quarantine and the isolated
//      file-processor scans it and reads its header and a 3-row sample
//   2. mapping: the user assigns each column to a field or variable of the
//      list (or skips it); then the file-processor validates every row and
//      the worker loads the valid ones
// An import left waiting for its mapping expires after 24 hours.

export const toImport = (row) => ({
  id: row.id, listId: row.list_id, originalName: row.original_name, sizeBytes: row.size_bytes, sha256: row.sha256,
  status: row.status, totalRows: row.total_rows, inserted: row.inserted, updated: row.updated, rejected: row.rejected,
  errors: row.errors, failureReason: row.failure_reason, createdBy: row.created_by_username,
  createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
  header: row.header ?? null, sample: row.status === 'awaiting_mapping' ? row.sample ?? null : null, mapping: row.mapping ?? null,
});

const MAPPING_ERRORS = { mapping_length: 'mapping_length', unknown_target: 'unknown_target', missing_email_column: 'missing_email_column', duplicate_target: 'duplicate_target' };

export function createImportsService({ db, repository, audit, store, fileQueue }) {
  const record = (client, auth, context, action, id, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'contact_import', resourceId: id, result: 'success', context, metadata,
  });
  const listForWrite = (client, auth, id) => findForWrite(auth, {
    resourceType: 'contact_list', id, find: (scope) => repository.list(client, scope, id),
  });
  const importForWrite = (client, auth, id) => findForWrite(auth, {
    resourceType: 'contact_import', id, find: (scope, { lock = true } = {}) => repository.importInScope(client, scope, id, { forUpdate: lock }),
  });

  return {
    // Stores the upload in quarantine and queues the scan and preview.
    async start(auth, listId, file, context) {
      const list = await listForWrite(db, auth, listId);
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
        await record(client, auth, context, 'contacts.import_request', importId, { listId, originalName, sizeBytes: saved.size, sha256: saved.sha256 });
        return importId;
      });
      try {
        await fileQueue.add('contacts_csv_preview', { kind: 'contacts_csv_preview', fileId: saved.id, importId: id }, { jobId: `preview-${saved.id}` });
      } catch (error) {
        await repository.finishImport(db, id, { status: 'failed', failureReason: 'queue_unavailable' });
        await store.remove('incoming', saved.id);
        throw error;
      }
      return toImport(await repository.importInScope(db, { all: true }, id));
    },

    // `mapping`: one target per CSV column (fixed field, variable or null).
    async map(auth, id, { mapping }, context) {
      const outcome = await withTransaction(db, async (client) => {
        const row = await importForWrite(client, auth, id);
        if (row.status !== 'awaiting_mapping' || !row.header) throw new ConflictError('La importación no está esperando la asociación de columnas');
        const list = await repository.list(client, { all: true }, row.list_id, { forUpdate: true });
        const checked = validateMapping(mapping, row.header, list.attributes);
        if (checked.error) throw new ValidationError([{ field: 'mapping', code: MAPPING_ERRORS[checked.error] }]);
        await repository.startMapping(client, id, mapping);
        await record(client, auth, context, 'contacts.import_mapping', id, { listId: row.list_id, mapping });
        return { fileId: row.file_id, attributes: list.attributes, types: list.attribute_types };
      });
      try {
        await fileQueue.add('contacts_csv', { kind: 'contacts_csv', fileId: outcome.fileId, importId: id, mapping, attributes: outcome.attributes, types: outcome.types },
          { jobId: `import-${outcome.fileId}` });
      } catch (error) {
        await repository.finishImport(db, id, { status: 'failed', failureReason: 'queue_unavailable' });
        await store.remove('incoming', outcome.fileId);
        throw error;
      }
      return toImport(await repository.importInScope(db, { all: true }, id));
    },

    // Discards an import still waiting for its mapping; the file is deleted.
    async cancel(auth, id, context) {
      const fileId = await withTransaction(db, async (client) => {
        const row = await importForWrite(client, auth, id);
        if (row.status !== 'awaiting_mapping') throw new ConflictError('Solo se cancela una importación que espera la asociación de columnas');
        await repository.finishImport(client, id, { status: 'failed', failureReason: 'cancelled' });
        await record(client, auth, context, 'contacts.import_cancel', id, { listId: row.list_id });
        return row.file_id;
      });
      await store.remove('incoming', fileId).catch(() => {});
      return toImport(await repository.importInScope(db, { all: true }, id));
    },

    async list(auth, listId) {
      const row = await repository.list(db, areaScopeFor(auth), listId);
      if (!row) throw new NotFoundError();
      return (await repository.imports(db, listId)).map(toImport);
    },

    async get(auth, id) {
      const row = await repository.importInScope(db, areaScopeFor(auth), id);
      if (!row) throw new NotFoundError();
      return toImport(row);
    },
  };
}
