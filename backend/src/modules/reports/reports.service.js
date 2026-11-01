import { createHash } from 'node:crypto';
import { actorFrom } from '../../core/audit/audit.service.js';
import { areaScopeFor } from '../../core/authorization/area-scope.js';
import { NotFoundError } from '../../core/errors/errors.js';
import { maskEmail } from '../../core/privacy/mask.js';

// Reports by campaign and by contact (Parte B, ADR-025). Area scope on every
// query; emails masked for profiles without contacts.view (also in the
// export); exports and contact lookups audited. Opens are approximate
// (pixel blocked or preloaded by mail clients): the UI says so.

const iso = (value) => (value ? value.toISOString() : null);

const summary = (row) => ({
  recipients: row.recipients, accepted: row.accepted, rejected: row.rejected, suppressed: row.suppressed, pending: row.pending,
  notSent: row.not_sent, delivered: row.delivered, opened: row.opened, clicked: row.clicked, hardBounces: row.hard_bounces,
  softBounces: row.soft_bounces, complaints: row.complaints, unsubscribes: row.unsubscribes,
});

const toCampaign = (row) => ({
  id: row.id, name: row.name, subject: row.subject, status: row.status, areaId: row.area_id, areaName: row.area_name,
  startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), stats: summary(row),
});

export const EXPORT_COLUMNS = ['email', 'status', 'sent_at', 'delivered', 'opens', 'clicks', 'hard_bounce', 'soft_bounce', 'complaint', 'unsubscribed', 'last_event_at', 'error'];

export function createReportsService({ db, repository, audit }) {
  const unmasked = (auth) => auth.permissions.has('contacts.view');
  const emailFor = (auth) => (email) => (unmasked(auth) ? email : maskEmail(email));
  const toRecipient = (show) => (row) => ({
    id: row.id, email: show(row.email), status: row.status, sentAt: iso(row.sent_at), error: row.error, delivered: row.delivered,
    opens: row.opens, clicks: row.clicks, hardBounce: row.hard_bounce, softBounce: row.soft_bounce, complaint: row.complaint,
    unsubscribed: row.unsubscribed, lastEventAt: iso(row.last_event_at),
  });
  const record = (auth, context, action, resourceType, id, metadata) => audit.record(db, {
    actor: actorFrom(auth), action, resourceType, resourceId: id, result: 'success', context, metadata,
  });

  async function campaignInScope(auth, id) {
    const row = await repository.campaign(db, areaScopeFor(auth), id);
    if (!row) throw new NotFoundError();
    return row;
  }

  return {
    async campaigns(auth, { search, from, to, page, pageSize }) {
      const { rows, total } = await repository.campaigns(db, areaScopeFor(auth), { search, from, to, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: rows.map(toCampaign), total };
    },

    async campaign(auth, id) {
      return toCampaign(await campaignInScope(auth, id));
    },

    async recipients(auth, id, { status, event, page, pageSize }) {
      await campaignInScope(auth, id);
      const { rows, total } = await repository.recipients(db, id, { status, event, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: rows.map(toRecipient(emailFor(auth))), total };
    },

    // Searching by address reveals who received what: audited with the
    // email hash only (the address itself is never logged or audited).
    async contact(auth, { email }, { page, pageSize }, context) {
      const scope = areaScopeFor(auth);
      const { rows, total } = await repository.contact(db, scope, email, { limit: pageSize, offset: (page - 1) * pageSize });
      const emailHash = createHash('sha256').update(email.toLowerCase()).digest('hex');
      await record(auth, context, 'reports.contact_lookup', 'contact', emailHash, { results: total });
      const show = emailFor(auth);
      return {
        total,
        items: rows.map((row) => ({
          ...toRecipient(show)(row), campaignId: row.campaign_id, campaignName: row.campaign_name, areaName: row.area_name, startedAt: iso(row.started_at),
        })),
      };
    },

    async exportCampaign(auth, id, context) {
      const campaign = await campaignInScope(auth, id);
      const masked = !unmasked(auth);
      await record(auth, context, 'reports.export', 'campaign', id, { recipients: campaign.recipients, masked });
      const show = emailFor(auth);
      async function* rows() {
        for await (const page of repository.exportRecipients(db, id)) {
          yield page.map((row) => [show(row.email), row.status, row.sent_at, row.delivered, row.opens, row.clicks, row.hard_bounce,
            row.soft_bounce, row.complaint, row.unsubscribed, row.last_event_at, row.error]);
        }
      }
      return { campaign: toCampaign(campaign), rows: rows() };
    },
  };
}
