import { createInterface } from 'node:readline';
import { withTransaction } from '../../../core/db/transaction.js';
import { createContactsRepository } from '../contacts.repository.js';

// Worker side of a contacts import (ADR-004): applies the file-processor's
// outcome. Valid rows are upserted in batches inside one transaction, so the
// import is all or nothing; a repeated job finds the import already finished
// and does nothing (idempotent).

const BATCH = 500;

export function createImportResultsHandler({ pool, store, audit, logger }) {
  const repository = createContactsRepository();

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
