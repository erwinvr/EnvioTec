import { createInterface } from 'node:readline';
import { withTransaction } from '../../../core/db/transaction.js';

// Worker side of a contacts import (ADR-004): applies the file-processor's
// outcome. Valid rows are upserted in batches inside one transaction, so the
// import is all or nothing; a repeated job finds the import already finished
// and does nothing (idempotent).

const BATCH = 500;

export function createImportResultsHandler({ pool, repository, store, audit, logger }) {

  async function* batches(fileId) {
    const lines = createInterface({ input: store.read('results', fileId), crlfDelay: Infinity });
    let batch = [];
    for await (const line of lines) {
      if (line.trim() === '') continue;
      batch.push(JSON.parse(line));
      if (batch.length === BATCH) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  return async function handle({ fileId, outcome }) {
    try {
      await withTransaction(pool, async (client) => {
        const pending = await repository.pendingImportByFile(client, fileId);
        if (!pending) return;
        const context = { requestId: `job:contacts-import:${pending.id}` };
        const event = (result, metadata) => audit.record(client, {
          actor: { type: 'system' }, action: 'contacts.import', resourceType: 'contact_import', resourceId: pending.id,
          result, context, metadata: { listId: pending.list_id, requestedBy: pending.created_by, ...metadata },
        });
        if (outcome.status !== 'ok') {
          await repository.finishImport(client, pending.id, { status: 'failed', failureReason: outcome.reason, errors: [] });
          await event('failure', { reason: outcome.reason, signature: outcome.signature ?? null });
          return;
        }
        let inserted = 0;
        let updated = 0;
        for await (const rows of batches(fileId)) {
          const counts = await repository.upsertContacts(client, { areaId: pending.area_id, listId: pending.list_id, rows, actorId: pending.created_by });
          inserted += counts.inserted;
          updated += counts.updated;
        }
        await repository.finishImport(client, pending.id, {
          status: 'completed', totalRows: outcome.totalRows, inserted, updated, rejected: outcome.rejected, errors: outcome.errors,
        });
        await event('success', { totalRows: outcome.totalRows, inserted, updated, rejected: outcome.rejected });
      });
    } finally {
      await store.remove('results', fileId).catch((error) => logger.warn({ errorMessage: error.message }, 'could not remove results file'));
    }
  };
}

// Outcome of the preview (ADR-028): the header and sample are stored for
// the user to map columns; the upload stays in quarantine. A rejected file
// (malware, not text, empty) ends the import here.
export function createImportPreviewHandler({ pool, repository, audit }) {
  return async function handle({ fileId, outcome }) {
    await withTransaction(pool, async (client) => {
      const pending = await repository.previewImportByFile(client, fileId);
      if (!pending) return;
      if (outcome.status === 'ok') {
        await repository.setPreview(client, pending.id, outcome);
        return;
      }
      await repository.finishImport(client, pending.id, { status: 'failed', failureReason: outcome.reason, errors: [] });
      await audit.record(client, {
        actor: { type: 'system' }, action: 'contacts.import', resourceType: 'contact_import', resourceId: pending.id, result: 'failure',
        context: { requestId: `job:contacts-preview:${pending.id}` },
        metadata: { listId: pending.list_id, requestedBy: pending.created_by, reason: outcome.reason, signature: outcome.signature ?? null },
      });
    });
  };
}

// Imports left waiting for their mapping expire after 24 hours: the file in
// quarantine is deleted and the import ends as failed (audited).
export const MAPPING_EXPIRY_HOURS = 24;

export function createImportExpiryJob({ pool, repository, store, audit, logger }) {
  return async function run() {
    const expired = await withTransaction(pool, async (client) => {
      const rows = await repository.expiredAwaitingImports(client, MAPPING_EXPIRY_HOURS);
      for (const row of rows) {
        await repository.finishImport(client, row.id, { status: 'failed', failureReason: 'mapping_expired' });
        await audit.record(client, {
          actor: { type: 'system' }, action: 'contacts.import', resourceType: 'contact_import', resourceId: row.id, result: 'failure',
          context: { requestId: `job:import-expiry:${row.id}` }, metadata: { listId: row.list_id, requestedBy: row.created_by, reason: 'mapping_expired' },
        });
      }
      return rows;
    });
    for (const row of expired) {
      await store.remove('incoming', row.file_id).catch((error) => logger.warn({ errorMessage: error.message }, 'could not remove an expired upload'));
    }
    return { expired: expired.length };
  };
}
