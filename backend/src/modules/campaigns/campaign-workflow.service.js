import { actorFrom } from '../../core/audit/audit.service.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { ConflictError, ValidationError } from '../../core/errors/errors.js';
import {
  assertApprover, assertCancellable, assertReadyToSubmit, assertStatus, assertTestRecipient, assertTestSendsLeft,
} from './campaign-rules.js';
import { toCampaign } from './campaigns.service.js';
import { scheduleByDateOf, WINDOW_DAYS } from './date-schedule.js';

// Campaign workflow (Parte B, ADR-011): submit, approve (snapshot +
// quota reservation in one transaction), reject, cancel, pause, resume and
// test sends. Every step is audited; approval needs a reauthentication.
// Only in the user's own area (ADR-026), except pause and cancel: they only
// stop sending, so whoever reads every area can use them against abuse.

export function createCampaignWorkflow({ db, repository, campaigns, audit, quotas, sendQueue }) {
  const record = (client, auth, context, action, id, metadata, result = 'success') => audit.record(client, {
    actor: actorFrom(auth), action, resourceType: 'campaign', resourceId: id, result, context, metadata,
  });
  const reload = async (client, id) => toCampaign(await repository.find(client, { all: true }, id));

  // A draft follows its template: before a test send or the submission it
  // moves to the latest ready version. From approval on, the version is
  // frozen (T12): what was approved is what is sent.
  async function followLatestVersion(client, campaign) {
    if (campaign.status !== 'draft') return;
    const latest = await repository.latestReadyVersion(client, campaign.template_id, campaign.area_id);
    if (!latest || latest === campaign.template_version_id) return;
    await repository.setTemplateVersion(client, campaign.id, latest);
    campaign.template_version_id = latest;
    campaign.versionUpdated = true;
  }

  async function readiness(client, campaign) {
    const refs = await repository.references(client, campaign.area_id, {
      templateVersionId: campaign.template_version_id, listId: campaign.list_id, senderId: campaign.sender_id,
    });
    const attachment = campaign.attachment_id ? await repository.attachment(client, campaign.attachment_id) : null;
    assertReadyToSubmit({ campaign, version: refs.version, list: refs.list, sender: refs.sender, attachment, recipientsInList: refs.recipients });
  }

  return {
    async submit(auth, id, context) {
      return withTransaction(db, async (client) => {
        const campaign = await campaigns.forWrite(client, auth, id, { forUpdate: true });
        assertStatus(campaign, ['draft']);
        await followLatestVersion(client, campaign);
        await readiness(client, campaign);
        await repository.setStatus(client, id, 'submitted', { submitted_by: auth.user.id, submitted_at: new Date() });
        await record(client, auth, context, 'campaign.submit', id, { templateVersionId: campaign.template_version_id, versionUpdated: campaign.versionUpdated === true });
        return reload(client, id);
      });
    },

    // Approval (Parte B): a different person, same area, recent
    // reauthentication. Snapshot of recipients without suppressions, and the
    // creator's quota reserved under a row lock: insufficient -> not approved.
    async approve(auth, id, context) {
      assertRecentReauth(auth);
      return withTransaction(db, async (client) => {
        const campaign = await campaigns.forWrite(client, auth, id, { forUpdate: true });
        assertStatus(campaign, ['submitted']);
        assertApprover(campaign, auth.user.id);
        await readiness(client, campaign);
        const creator = await repository.creatorState(client, campaign.created_by);
        if (!creator?.present || creator.status !== 'active' || !creator.in_validity) {
          throw new ConflictError('La cuenta que creó la campaña no está activa o vigente: su saldo no se puede usar');
        }
        const byDate = scheduleByDateOf(campaign);
        let count;
        let scheduledAt = campaign.scheduled_at;
        let excluded = {};
        if (byDate) {
          // ADR-030: each recipient on its own date; the rest left out and counted.
          const snapshot = await repository.snapshotRecipientsByDate(client, id, campaign.list_id, byDate, WINDOW_DAYS);
          count = snapshot.count;
          scheduledAt = snapshot.first_send_at;
          excluded = { excluded_no_date: snapshot.no_date, excluded_past: snapshot.past, excluded_too_far: snapshot.too_far };
          if (count === 0) {
            throw new ValidationError([{ field: 'scheduleByDate', code: 'no_recipients_in_window' }], 'Ningún contacto tiene una fecha de envío dentro de la ventana');
          }
        } else {
          count = await repository.snapshotRecipients(client, id, campaign.list_id);
          if (count === 0) throw new ValidationError([{ field: 'listId', code: 'no_recipients' }], 'Todos los contactos están suprimidos');
        }
        await quotas.reserve(client, { userId: campaign.created_by, amount: count, campaignId: id, actor: actorFrom(auth), context });
        const status = scheduledAt && new Date(scheduledAt) > new Date() ? 'scheduled' : 'approved';
        await repository.setStatus(client, id, status, {
          approved_by: auth.user.id, approved_at: new Date(), recipient_count: count, reserved: count, ...(byDate ? { scheduled_at: scheduledAt } : {}), ...excluded,
        });
        await record(client, auth, context, 'campaign.approve', id, { recipients: count, status, byDate: byDate !== null, ...excluded });
        return reload(client, id);
      });
    },

    async reject(auth, id, { reason }, context) {
      return withTransaction(db, async (client) => {
        const campaign = await campaigns.forWrite(client, auth, id, { forUpdate: true });
        assertStatus(campaign, ['submitted']);
        assertApprover(campaign, auth.user.id);
        await repository.resetToDraft(client, id);
        await repository.setStatus(client, id, 'draft', { rejection_reason: reason });
        await record(client, auth, context, 'campaign.reject', id, { reason });
        return reload(client, id);
      });
    },

    // Releases what was reserved and not consumed (ADR-011).
    async cancel(auth, id, { reason }, context) {
      return withTransaction(db, async (client) => {
        const campaign = await campaigns.inScope(client, auth, id, { forUpdate: true });
        assertCancellable(campaign);
        if (campaign.reserved > 0) {
          await quotas.release(client, { userId: campaign.created_by, amount: campaign.reserved, campaignId: id, actor: actorFrom(auth), context });
        }
        await repository.cancelPendingRecipients(client, id);
        await repository.setStatus(client, id, 'cancelled', { cancel_reason: reason, cancelled_at: new Date(), cancelled_by: auth.user.id, reserved: 0 });
        await record(client, auth, context, 'campaign.cancel', id, { reason, released: campaign.reserved, previousStatus: campaign.status });
        return reload(client, id);
      });
    },

    async pause(auth, id, context) {
      return withTransaction(db, async (client) => {
        const campaign = await campaigns.inScope(client, auth, id, { forUpdate: true });
        assertStatus(campaign, ['sending', 'approved', 'scheduled']);
        await repository.setStatus(client, id, 'paused');
        await record(client, auth, context, 'campaign.pause', id, { previousStatus: campaign.status });
        return reload(client, id);
      });
    },

    async resume(auth, id, context) {
      return withTransaction(db, async (client) => {
        const campaign = await campaigns.forWrite(client, auth, id, { forUpdate: true });
        assertStatus(campaign, ['paused']);
        await repository.setStatus(client, id, campaign.started_at ? 'sending' : 'approved');
        await record(client, auth, context, 'campaign.resume', id, {});
        return reload(client, id);
      });
    },

    // Test send (Parte B): own email or allowed internal domains, at most N
    // per user per day; consumes 1 from the balance and the global cap.
    async testSend(auth, id, { email }, context) {
      const settings = await repository.settings(db, ['test_send.daily_max_per_user', 'test_send.allowed_domains']);
      assertTestRecipient(email, { userEmail: auth.user.email, allowedDomains: settings['test_send.allowed_domains'] ?? [] });
      const created = await withTransaction(db, async (client) => {
        const campaign = await campaigns.forWrite(client, auth, id, { forUpdate: true });
        assertStatus(campaign, ['draft', 'submitted', 'approved', 'scheduled', 'paused']);
        await followLatestVersion(client, campaign);
        await readiness(client, campaign);
        await repository.lockTestSends(client, auth.user.id);
        assertTestSendsLeft(await repository.testSendsToday(client, auth.user.id), settings['test_send.daily_max_per_user']);
        await quotas.consume(client, { userId: auth.user.id, amount: 1, campaignId: id, fromReserve: false, actor: actorFrom(auth), context });
        const test = await repository.createTestSend(client, { campaignId: id, userId: auth.user.id, email: email.toLowerCase() });
        await record(client, auth, context, 'campaign.test_send', id, { testSendId: test.id, templateVersionId: campaign.template_version_id, versionUpdated: campaign.versionUpdated === true });
        return test;
      });
      try {
        await sendQueue.add('test_send', { kind: 'test_send', testSendId: created.id }, { jobId: `test-${created.id}` });
      } catch (error) {
        await repository.finishTestSend(db, created.id, { status: 'failed', error: 'queue_unavailable' });
        throw error;
      }
      return { id: created.id, status: created.status, createdAt: created.created_at.toISOString() };
    },
  };
}
