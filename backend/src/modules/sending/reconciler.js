import { withTransaction } from '../../core/db/transaction.js';
import { SYSTEM } from './sender-context.js';

// A batch with an unknown outcome (timeout after sending) is looked up
// recipient by recipient by email, which needs no indexed metadata, and
// confirmed by the batch_id Mandrill returns with each message (ADR-029).
// Only batches older than the delay of Mandrill's search index are
// reconciled, so a message not indexed yet is never taken as not sent and
// sent twice.

// Addresses that can go into a search query as they are (no spaces or quotes).
const SEARCHABLE_EMAIL = /^[^\s"'\\:]+@[^\s"'\\:]+$/;
const day = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

export function createReconciler({ pool, repository, quotas, mandrill, logger, shared }) {
  const { context, event } = shared;

  // Message id of each recipient found in Mandrill with this batch id; null
  // when the batch cannot be checked now (it stays ambiguous).
  async function findSent(batchId) {
    const range = { dateFrom: day(-2), dateTo: day(0) };
    const recipients = await repository.batchRecipients(pool, batchId, ['sending']);
    // An address that cannot be searched leaves the batch for review: never resent blindly.
    if (recipients.some(({ email }) => !SEARCHABLE_EMAIL.test(email))) {
      logger.warn({ batchId }, 'ambiguous batch needs manual review: an address cannot be searched');
      return null;
    }
    const sent = new Map();
    for (const { email } of recipients) {
      const found = await mandrill.search({ query: `email:${email}`, ...range, limit: 100 });
      const match = found.find((message) => message.metadata?.batch_id === batchId);
      if (match) sent.set(email.toLowerCase(), match._id);
    }
    return sent;
  }

  // Returns false when another run already settled the batch.
  async function settle(id, campaignId, sentEmails) {
    return withTransaction(pool, async (client) => {
      const campaign = await repository.lockCampaign(client, campaignId);
      const batch = await repository.lockBatch(client, id);
      if (batch.status !== 'ambiguous') return false;
      const recipients = await repository.batchRecipients(client, id, ['sending']);
      const rows = recipients.filter((r) => sentEmails.has(r.email.toLowerCase()))
        .map((r) => ({ email: r.email, status: 'sent', message_id: sentEmails.get(r.email.toLowerCase()), error: null }));
      await repository.recordResults(client, id, rows);
      const notSent = recipients.length - rows.length;
      if (notSent > 0) {
        await quotas.refund(client, { userId: campaign.created_by, amount: notSent, campaignId, actor: SYSTEM, context: context('reconcile', id) });
        await repository.addReserved(client, campaignId, notSent);
        await repository.markRecipients(client, id, 'sending', 'pending');
      }
      await repository.setBatch(client, id, notSent > 0 ? { status: 'pending' } : { status: 'accepted', accepted: rows.length, rejected: 0 });
      await event(client, 'campaign.batch_reconcile', 'send_batch', id, 'success', { campaignId, found: rows.length, retried: notSent });
      return true;
    });
  }

  return {
    async reconcile() {
      const summary = { reconciled: 0 };
      for (const { id, campaign_id: campaignId } of await repository.ambiguousBatches(pool)) {
        let sent;
        try {
          sent = await findSent(id);
        } catch (error) {
          logger.warn({ batchId: id, errorMessage: error.message }, 'reconciliation postponed');
          continue;
        }
        if (sent && await settle(id, campaignId, sent)) summary.reconciled += 1;
      }
      return summary;
    },
  };
}
