import { withTransaction } from '../../core/db/transaction.js';
import { MandrillError } from '../../core/mail/mandrill.js';
import { GlobalCapReachedError } from '../quotas/quotas.rules.js';
import { buildMessage } from './message.js';
import { ACCEPTED, SYSTEM } from './sender-context.js';

// Sends one batch (ADR-005, ADR-024): suppression applied again, quota and
// global cap consumed for the recipients actually sent, one Mandrill call;
// what Mandrill does not accept is refunded. A definite error puts the batch
// back; an unknown outcome leaves it ambiguous for the reconciler.

const MAX_ATTEMPTS = 5;

export function createBatchSender({ pool, repository, quotas, mandrill, mailer, logger, shared }) {
  const { context, event, contentOf } = shared;

  async function notifyCap(campaignId) {
    const settings = await repository.settings(pool, ['notifications.admin_emails']);
    for (const to of settings['notifications.admin_emails'] ?? []) {
      mailer.send({
        to, tag: 'global-cap', subject: 'EnvioTec: se alcanzó el tope global de envíos del mes',
        text: `Se alcanzó el tope global mensual de envíos. La campaña ${campaignId} quedó en pausa.\nThe monthly global send cap was reached; the campaign was paused.`,
      }).catch((error) => logger.error({ errorMessage: error.message }, 'cap notification failed'));
    }
  }

  // Puts a batch back as it was before the call: refund and pending again.
  async function putBack(client, batch, campaign, count, error) {
    await quotas.refund(client, { userId: campaign.created_by, amount: count, campaignId: campaign.id, actor: SYSTEM, context: context('batch', batch.id) });
    await repository.addReserved(client, campaign.id, count);
    const exhausted = batch.attempts + 1 >= MAX_ATTEMPTS;
    await repository.markRecipients(client, batch.id, 'sending', exhausted ? 'failed' : 'pending');
    await repository.setBatch(client, batch.id, { status: exhausted ? 'failed' : 'pending', attempt: true, error });
    await event(client, 'campaign.batch_send', 'send_batch', batch.id, 'failure', { campaignId: campaign.id, error, exhausted });
  }

  // Step 1: claim the batch (campaign locked first, then the batch).
  async function claim(campaignId, batchId) {
    let claimed = null;
    let capReached = false;
    await withTransaction(pool, async (client) => {
      const campaign = await repository.lockCampaign(client, campaignId);
      const batch = await repository.lockBatch(client, batchId);
      if (batch.status !== 'pending') return;
      if (campaign.status === 'cancelled') {
        await repository.markRecipients(client, batchId, 'pending', 'cancelled');
        await repository.setBatch(client, batchId, { status: 'cancelled' });
        return;
      }
      if (campaign.status !== 'sending') return;
      await repository.suppressBatch(client, batchId);
      const recipients = await repository.batchRecipients(client, batchId, ['pending']);
      if (recipients.length === 0) {
        await repository.setBatch(client, batchId, { status: 'accepted', accepted: 0, rejected: 0 });
        return;
      }
      try {
        await quotas.consume(client, {
          userId: campaign.created_by, amount: recipients.length, campaignId: campaign.id, actor: SYSTEM, context: context('batch', batchId),
        });
      } catch (error) {
        if (!(error instanceof GlobalCapReachedError)) throw error;
        capReached = true;
        return;
      }
      await repository.addReserved(client, campaign.id, -recipients.length);
      await repository.markRecipients(client, batchId, 'pending', 'sending');
      await repository.setBatch(client, batchId, { status: 'in_flight' });
      claimed = { campaign, batch, recipients, content: await contentOf(client, campaign) };
    });
    return { claimed, capReached };
  }

  // Parte B: at the global cap the campaign pauses and administrators are told.
  async function pauseAtCap(campaignId) {
    await withTransaction(pool, async (client) => {
      await repository.pauseCampaign(client, campaignId);
      await event(client, 'campaign.pause', 'campaign', campaignId, 'success', { reason: 'global_cap' });
    });
    await notifyCap(campaignId);
  }

  // Step 3: record what Mandrill accepted; refund what it rejected.
  async function record({ campaign, recipients }, batchId, results) {
    const byEmail = new Map(results.map((result) => [result.email.toLowerCase(), result]));
    const rows = recipients.map((r) => {
      const result = byEmail.get(r.email.toLowerCase());
      if (result && ACCEPTED.has(result.status)) return { email: r.email, status: 'sent', message_id: result._id ?? null, error: null };
      return { email: r.email, status: 'rejected', message_id: result?._id ?? null, error: (result?.reject_reason ?? 'not_in_response').slice(0, 200) };
    });
    const rejected = rows.filter((row) => row.status === 'rejected').length;
    await withTransaction(pool, async (client) => {
      await repository.recordResults(client, batchId, rows);
      if (rejected > 0) {
        await quotas.refund(client, { userId: campaign.created_by, amount: rejected, campaignId: campaign.id, actor: SYSTEM, context: context('batch', batchId) });
        await repository.addReserved(client, campaign.id, rejected);
      }
      await repository.setBatch(client, batchId, { status: 'accepted', attempt: true, accepted: rows.length - rejected, rejected });
      await event(client, 'campaign.batch_send', 'send_batch', batchId, 'success', { campaignId: campaign.id, accepted: rows.length - rejected, rejected });
    });
    return { accepted: rows.length - rejected, rejected };
  }

  return {
    async sendBatch(batchId) {
      const campaignId = await repository.batchCampaignId(pool, batchId);
      if (!campaignId) return { skipped: 'unknown_batch' };
      const { claimed, capReached } = await claim(campaignId, batchId);
      if (capReached) {
        await pauseAtCap(campaignId);
        return { paused: 'global_cap' };
      }
      if (!claimed) return { skipped: 'not_sendable' };

      // Step 2: one Mandrill call for the whole batch.
      const { campaign, batch, recipients, content } = claimed;
      if (!content) {
        await withTransaction(pool, (client) => putBack(client, batch, campaign, recipients.length, 'content_unavailable'));
        return { putBack: 'content_unavailable' };
      }
      let results;
      try {
        results = await mandrill.send(buildMessage({ campaignId: campaign.id, batchId, subject: campaign.subject, ...content, recipients }));
      } catch (error) {
        if (error instanceof MandrillError && error.definite) {
          await withTransaction(pool, (client) => putBack(client, batch, campaign, recipients.length, `mandrill_${error.status}_${error.mandrillName ?? ''}`.slice(0, 200)));
          return { putBack: error.status };
        }
        // Unknown outcome: never retried blindly (ADR-005).
        await withTransaction(pool, async (client) => {
          await repository.setBatch(client, batchId, { status: 'ambiguous', attempt: true, error: 'outcome_unknown' });
          await event(client, 'campaign.batch_send', 'send_batch', batchId, 'failure', { campaignId: campaign.id, error: 'outcome_unknown' });
        });
        return { ambiguous: true };
      }
      return record(claimed, batchId, results);
    },
  };
}
