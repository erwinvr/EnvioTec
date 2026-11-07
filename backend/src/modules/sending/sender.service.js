import { readFile } from 'node:fs/promises';
import { withTransaction } from '../../core/db/transaction.js';
import { MandrillError } from '../../core/mail/mandrill.js';
import { GlobalCapReachedError } from '../quotas/quotas.rules.js';
import { buildMessage } from './message.js';

// Campaign sender (ADR-005, ADR-024), run by the worker:
//   dispatch()   due campaigns start sending; their recipients are split
//                into batches; pending batches are queued; finished
//                campaigns complete and release what is left of the
//                reservation
//   sendBatch()  suppression applied again, quota and global cap consumed
//                for the recipients actually sent, one Mandrill call per
//                batch; what Mandrill does not accept is refunded
//   reconcile()  a batch with an unknown outcome (timeout after sending) is
//                looked up in Mandrill by its metadata before any retry,
//                so nobody receives the campaign twice
//   testSend()   a single message to the test address

const MAX_ATTEMPTS = 5;
const ACCEPTED = new Set(['sent', 'queued', 'scheduled']);
const SYSTEM = { type: 'system' };
// Addresses that can go into a search query as they are (no spaces or quotes).
const SEARCHABLE_EMAIL = /^[^\s"'\\:]+@[^\s"'\\:]+$/;

export function createSender({ pool, repository, quotas, mandrill, store, audit, sendQueue, mailer, logger, batchSize }) {
  // Stays within the 64 characters of audit_logs.request_id.
  const context = (kind, id) => ({ requestId: `job:${kind.replace(/^campaign\./, '')}:${id}`.slice(0, 64) });
  const event = (client, action, resourceType, id, result, metadata) => audit.record(client, {
    actor: SYSTEM, action, resourceType, resourceId: id, result, context: context(action, id), metadata,
  });

  async function readBase64(id) {
    return (await readFile(store.pathOf('stored', id))).toString('base64');
  }

  async function contentOf(client, campaign) {
    const row = await repository.content(client, campaign);
    // The PDF is optional (ADR-027); if the campaign has one, it must be the inspected one.
    if (!row || !row.sender_active || (campaign.attachment_id && row.attachment_status !== 'ready')) return null;
    const images = [];
    for (const image of row.images) images.push({ cid: image.cid, contentType: image.contentType, base64: await readBase64(image.fileId) });
    return {
      content: { html: row.html, text: row.text_body, variables: row.variables, images },
      sender: { email: row.sender_email, display_name: row.display_name, reply_to: row.reply_to },
      attachment: row.attachment_file ? { name: row.attachment_name, base64: await readBase64(row.attachment_file) } : null,
    };
  }

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

  return {
    async dispatch() {
      const summary = { started: 0, queued: 0, completed: 0 };
      for (const id of await repository.dueCampaigns(pool)) {
        await withTransaction(pool, async (client) => {
          const campaign = await repository.lockCampaign(client, id);
          if (!campaign || !['approved', 'scheduled'].includes(campaign.status)) return;
          await repository.startCampaign(client, id);
          await repository.createBatches(client, id, batchSize);
          await event(client, 'campaign.start', 'campaign', id, 'success', {});
          summary.started += 1;
        });
      }
      for (const id of await repository.sendingCampaigns(pool)) {
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
      return summary;
    },

    async sendBatch(batchId) {
      // Step 1: claim the batch (campaign locked first, then the batch).
      const head = await pool.query('SELECT campaign_id FROM send_batches WHERE id = $1', [batchId]);
      if (head.rows.length === 0) return { skipped: 'unknown_batch' };
      let claimed = null;
      let capReached = false;
      await withTransaction(pool, async (client) => {
        const campaign = await repository.lockCampaign(client, head.rows[0].campaign_id);
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
      if (capReached) {
        // Parte B: at the global cap the campaign pauses and administrators are told.
        await withTransaction(pool, async (client) => {
          await repository.pauseCampaign(client, head.rows[0].campaign_id);
          await event(client, 'campaign.pause', 'campaign', head.rows[0].campaign_id, 'success', { reason: 'global_cap' });
        });
        await notifyCap(head.rows[0].campaign_id);
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

      // Step 3: record what Mandrill accepted; refund what it rejected.
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
    },

    // A batch with an unknown outcome is looked up recipient by recipient by
    // email (which needs no indexed metadata) and confirmed by the batch_id
    // Mandrill returns with each message (ADR-029). Only batches older than
    // the delay of Mandrill's search index are reconciled, so a message not
    // indexed yet is never taken as not sent and sent twice.
    async reconcile() {
      const summary = { reconciled: 0 };
      for (const { id, campaign_id: campaignId } of await repository.ambiguousBatches(pool)) {
        const sentEmails = new Map();
        try {
          const range = { dateFrom: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), dateTo: new Date().toISOString().slice(0, 10) };
          const recipients = await repository.batchRecipients(pool, id, ['sending']);
          // An address that cannot be searched leaves the batch for review: never resent blindly.
          if (recipients.some(({ email }) => !SEARCHABLE_EMAIL.test(email))) {
            logger.warn({ batchId: id }, 'ambiguous batch needs manual review: an address cannot be searched');
            continue;
          }
          for (const { email } of recipients) {
            const found = await mandrill.search({ query: `email:${email}`, ...range, limit: 100 });
            const match = found.find((message) => message.metadata?.batch_id === id);
            if (match) sentEmails.set(email.toLowerCase(), match._id);
          }
        } catch (error) {
          logger.warn({ batchId: id, errorMessage: error.message }, 'reconciliation postponed');
          continue;
        }
        await withTransaction(pool, async (client) => {
          const campaign = await repository.lockCampaign(client, campaignId);
          const batch = await repository.lockBatch(client, id);
          if (batch.status !== 'ambiguous') return;
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
          summary.reconciled += 1;
        });
      }
      return summary;
    },

    // Without the campaign API key a test send ends as failed with a reason.
    async rejectTestSend(testSendId, error) {
      await withTransaction(pool, async (client) => {
        const test = await repository.lockTestSend(client, testSendId);
        if (test?.status === 'pending') await repository.finishTestSend(client, testSendId, { status: 'failed', error });
      });
    },

    // Test send (Parte B): already counted against the balance when it was
    // requested; variables shown as [name] so the layout can be checked.
    async testSend(testSendId) {
      let claimed = null;
      await withTransaction(pool, async (client) => {
        const test = await repository.lockTestSend(client, testSendId);
        if (!test || test.status !== 'pending') return;
        claimed = { test, content: await contentOf(client, test) };
      });
      if (!claimed) return { skipped: true };
      const { test, content } = claimed;
      const finish = (fields) => withTransaction(pool, async (client) => {
        await repository.finishTestSend(client, test.id, fields);
        await event(client, 'campaign.test_delivery', 'campaign', test.campaign_id, fields.status === 'sent' ? 'success' : 'failure', { testSendId: test.id, error: fields.error ?? null });
      });
      if (!content) return finish({ status: 'failed', error: 'content_unavailable' });
      const placeholder = Object.fromEntries(content.content.variables.map((name) => [name, `[${name}]`]));
      const recipient = { id: test.id, email: test.email, first_name: placeholder.first_name, last_name: placeholder.last_name, attributes: placeholder };
      try {
        const [result] = await mandrill.send(buildMessage({
          campaignId: test.campaign_id, batchId: `test-${test.id}`, subject: `[PRUEBA] ${test.subject}`, ...content, recipients: [recipient],
        }));
        return finish(ACCEPTED.has(result?.status) ? { status: 'sent', messageId: result._id ?? null } : { status: 'failed', error: (result?.reject_reason ?? 'rejected').slice(0, 200) });
      } catch (error) {
        return finish({ status: 'failed', error: (error.message ?? 'error').slice(0, 200) });
      }
    },
  };
}
