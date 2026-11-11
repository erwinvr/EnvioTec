import { withTransaction } from '../../core/db/transaction.js';
import { buildMessage } from './message.js';
import { ACCEPTED } from './sender-context.js';

// Test sends (Parte B): already counted against the balance when requested;
// variables shown as [name] so the layout can be checked. Without the
// campaign API key a test send ends as failed with a reason.

export function createTestSender({ pool, repository, mandrill, shared }) {
  const { event, contentOf } = shared;

  return {
    async rejectTestSend(testSendId, error) {
      await withTransaction(pool, async (client) => {
        const test = await repository.lockTestSend(client, testSendId);
        if (test?.status === 'pending') await repository.finishTestSend(client, testSendId, { status: 'failed', error });
      });
    },

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
