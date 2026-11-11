import { readFile } from 'node:fs/promises';
import { withTransaction } from '../../../core/db/transaction.js';

// Worker side of a template upload (ADR-004): stores the converted version
// and moves its images to the private store. Idempotent: a repeated result
// finds the version already processed.
export function createTemplateResultsHandler({ pool, repository, store, audit, logger }) {

  return async function handle({ fileId, outcome }) {
    // Images written by a rejected inspection are removed; accepted ones move.
    const leftovers = [...(outcome.imageFiles ?? [])];
    try {
      await withTransaction(pool, async (client) => {
        const pending = await repository.pendingVersionByFile(client, fileId);
        if (!pending) return;
        const event = (result, metadata) => audit.record(client, {
          actor: { type: 'system' }, action: 'template.version_process', resourceType: 'template', resourceId: pending.template_id,
          result, context: { requestId: `job:template:${pending.id}` },
          metadata: { version: pending.version, requestedBy: pending.created_by, ...metadata },
        });
        if (outcome.status !== 'ok') {
          await repository.finishVersion(client, pending.id, { status: 'failed', failureReason: outcome.reason });
          await event('failure', { reason: outcome.reason, signature: outcome.signature ?? null });
          return;
        }
        const result = JSON.parse(await readFile(store.pathOf('results', fileId), 'utf8'));
        for (const image of result.images) await store.move('results', 'stored', image.fileId);
        await repository.finishVersion(client, pending.id, {
          status: 'ready', html: result.html, text: result.text, variables: result.variables, images: result.images,
        });
        await event('success', { variables: result.variables, images: result.images.length });
      });
    } finally {
      await store.remove('results', fileId).catch(() => {});
      for (const id of leftovers) await store.remove('results', id).catch((error) => logger.warn({ errorMessage: error.message }, 'leftover image'));
    }
  };
}
