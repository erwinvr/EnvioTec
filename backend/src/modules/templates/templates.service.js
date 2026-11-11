import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor, writeFinder } from '../../core/authorization/area-scope.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, NotFoundError, ValidationError } from '../../core/errors/errors.js';
import { FileTooLargeError } from '../../core/files/storage.js';
import { safeFileName } from '../contacts/contacts.service.js';
import { LIMITS } from './template-rules.js';

// Templates (Parte B): numbered versions of a .docx, inspected and converted
// in the file-processor (ADR-004). Archived templates cannot be used by new
// campaigns; nothing is deleted, so sent campaigns keep their version.

export const toTemplate = (row) => ({
  id: row.id, areaId: row.area_id, areaName: row.area_name, name: row.name, description: row.description,
  isArchived: row.is_archived, latestReadyVersion: row.latest_ready,
});
export const toVersion = (row) => ({
  id: row.id, version: row.version, status: row.status, originalName: row.original_name, sizeBytes: row.size_bytes,
  sha256: row.sha256, variables: row.variables, images: row.images.length, failureReason: row.failure_reason,
  createdBy: row.created_by_username, createdAt: row.created_at.toISOString(), processedAt: row.processed_at?.toISOString() ?? null,
});

export function createTemplatesService({ db, repository, audit, store, fileQueue }) {
  const record = (client, auth, context, action, id, metadata) => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'template', resourceId: id, result: 'success', context, metadata,
  });

  async function inScope(client, auth, id, options) {
    const row = await repository.find(client, areaScopeFor(auth), id, options);
    if (!row) throw new NotFoundError();
    return row;
  }

  // Changes only in the user's own area (ADR-026).
  const forWrite = writeFinder(repository.find, 'template');

  return {
    inScope,

    async list(auth, { includeArchived }) {
      return (await repository.list(db, areaScopeFor(auth), { includeArchived })).map(toTemplate);
    },

    async get(auth, id) {
      const row = await inScope(db, auth, id);
      return { ...toTemplate(row), versions: (await repository.versions(db, id)).map(toVersion) };
    },

    async create(auth, input, context) {
      // Always the user's own area: areas.view_all does not allow creating elsewhere (ADR-026).
      const areaId = auth.user.areaId;
      return withTransaction(db, async (client) => {
        const area = areaId ? await repository.findArea(client, areaId) : null;
        if (!area || !area.is_active || (input.areaId !== undefined && input.areaId !== areaId)) {
          throw new ValidationError([{ field: 'areaId', code: 'invalid_area' }]);
        }
        const id = await repository.create(client, { ...input, areaId, actorId: auth.user.id });
        await record(client, auth, context, 'template.create', id, { name: input.name, areaId });
        return { ...toTemplate(await repository.find(client, { all: true }, id)), versions: [] };
      });
    },

    async update(auth, id, changes, context) {
      return withTransaction(db, async (client) => {
        const before = await forWrite(client, auth, id, { forUpdate: true });
        await repository.update(client, id, changes, auth.user.id);
        const after = await repository.find(client, { all: true }, id);
        await record(client, auth, context, { true: 'template.archive', false: 'template.unarchive' }[changes.isArchived] ?? 'template.update', id, {
          before: { name: before.name, description: before.description, isArchived: before.is_archived },
          after: { name: after.name, description: after.description, isArchived: after.is_archived },
        });
        return { ...toTemplate(after), versions: (await repository.versions(client, id)).map(toVersion) };
      });
    },

    async uploadVersion(auth, id, file, context) {
      const template = await forWrite(db, auth, id);
      if (template.is_archived) throw new AppError('La plantilla está archivada', { statusCode: 409, code: 'CONFLICT' });
      if (!file) throw new ValidationError([{ field: 'file', code: 'required' }]);
      const originalName = safeFileName(file.filename);
      // Only .docx: never .doc (binary) nor .docm (macros), Parte B.
      if (!originalName.toLowerCase().endsWith('.docx')) {
        file.file.resume();
        throw new ValidationError([{ field: 'file', code: 'not_docx' }], 'Solo se aceptan archivos .docx');
      }
      let saved;
      try {
        saved = await store.saveIncoming(file.file, { maxBytes: LIMITS.maxBytes });
      } catch (error) {
        if (error instanceof FileTooLargeError) throw new AppError('El archivo supera 10 MB', { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
        throw error;
      }
      const version = await withTransaction(db, async (client) => {
        await forWrite(client, auth, id, { forUpdate: true });
        const created = await repository.createVersion(client, { templateId: id, file: saved, originalName, actorId: auth.user.id });
        await record(client, auth, context, 'template.version_upload', id, {
          version: created.version, originalName, sizeBytes: saved.size, sha256: saved.sha256,
        });
        return created;
      });
      try {
        await fileQueue.add('template_docx', { kind: 'template_docx', fileId: saved.id, versionId: version.id }, { jobId: saved.id });
      } catch (error) {
        await repository.finishVersion(db, version.id, { status: 'failed', failureReason: 'queue_unavailable' });
        await store.remove('incoming', saved.id);
        throw error;
      }
      return toVersion(await repository.version(db, id, version.version));
    },

    async version(auth, id, number) {
      await inScope(db, auth, id);
      const row = await repository.version(db, id, number);
      if (!row) throw new NotFoundError();
      return row;
    },

    // Isolated preview (ADR-012): images inlined as data: URIs; the HTML was
    // sanitized when the version was processed.
    async previewHtml(auth, id, number) {
      const row = await this.version(auth, id, number);
      if (row.status !== 'ready') throw new AppError('La versión todavía no está lista', { statusCode: 409, code: 'CONFLICT' });
      let html = row.html;
      for (const image of row.images) {
        const chunks = [];
        for await (const chunk of store.read('stored', image.fileId)) chunks.push(chunk);
        html = html.replaceAll(`src="cid:${image.cid}"`, `src="data:${image.contentType};base64,${Buffer.concat(chunks).toString('base64')}"`);
      }
      return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Vista previa</title></head><body>${html}</body></html>`;
    },
  };
}
