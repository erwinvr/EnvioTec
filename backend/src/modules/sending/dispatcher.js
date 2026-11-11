import { withTransaction } from '../../core/db/transaction.js';
import { SYSTEM } from './sender-context.js';

// Starts due campaigns, splits the recipients whose moment arrived into
// batches (ADR-030), queues pending batches, and completes campaigns with
// nothing left, releasing what remains of their reservation.

export function createDispatcher({ pool, repository, quotas, sendQueue, batchSize, shared }) {
  const { context, event } = shared;

  async function start(id, summary) {
    await withTransaction(pool, async (client) => {
      const campaign = await repository.lockCampaign(client, id);
      if (!campaign || !['approved', 'scheduled'].includes(campaign.status)) return;
      await repository.startCampaign(client, id);
      await repository.createBatches(client, id, batchSize);
      await event(client, 'campaign.start', 'campaign', id, 'success', {});
      summary.started += 1;
    });
  }

  async function advance(id, summary) {
    // Recipients whose date arrived since the last run (ADR-030).
    await withTransaction(pool, async (client) => {
      const campaign = await repository.lockCampaign(client, id);
      if (campaign?.status === 'sending') await repository.createBatches(client, id, batchSize);
    });
    for (const batchId of await repository.batchesToQueue(pool, id)) {
      await sendQueue.add('batch', { kind: 'batch', batchId });
      summary.queued += 1;
    }
    await withTransaction(pool, async (client) => {
      const campaign = await repository.lockCampaign(client, id);
      if (campaign.status !== 'sending' || await repository.openBatches(client, id) > 0) return;
      if (campaign.reserved > 0) {
        await quotas.release(client, { userId: campaign.created_by, amount: campaign.reserved, campaignId: id, actor: SYSTEM, context: context('complete', id) });
      }
      await repository.completeCampaign(client, id);
      await event(client, 'campaign.complete', 'campaign', id, 'success', { released: campaign.reserved });
      summary.completed += 1;
    });
  }

  return {
    async dispatch() {
      const summary = { started: 0, queued: 0, completed: 0 };
      for (const id of await repository.dueCampaigns(pool)) await start(id, summary);
      for (const id of await repository.sendingCampaigns(pool)) await advance(id, summary);
      return summary;
    },
  };
}
