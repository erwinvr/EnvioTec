import { withTransaction } from '../../../core/db/transaction.js';

// Worker side of a campaign PDF (ADR-004): an approved file moves to the
// private store (stored/); a rejected one leaves nothing behind. Idempotent.
export function createAttachmentResultsHandler({ pool, repository, store, audit }) {

  return async function handle({ fileId, outcome }) {
    let approved = false;
    try {
      await withTransaction(pool, async (client) => {
        const pending = await repository.pendingAttachmentByFile(client, fileId);
        if (!pending) return;
        const ok = outcome.status === 'ok';
        // A retry after a rolled-back transaction finds the file already moved.
        if (ok) await store.move('results', 'stored', fileId).catch(async (error) => {
          if (!await store.size('stored', fileId).catch(() => null)) throw error;
        });
        approved = ok;
        await repository.finishAttachment(client, pending.id, ok ? { status: 'ready' } : { status: 'failed', failureReason: outcome.reason });
        await audit.record(client, {
          actor: { type: 'system' }, action: 'campaign.attachment_process', resourceType: 'campaign_attachment', resourceId: pending.id,
          result: ok ? 'success' : 'failure', context: { requestId: `job:attachment:${pending.id}` },
          metadata: { requestedBy: pending.created_by, reason: outcome.reason ?? null, detail: outcome.detail ?? null, signature: outcome.signature ?? null },
        });
      });
    } finally {
      if (!approved) await store.remove('results', fileId).catch(() => {});
    }
  };
}
