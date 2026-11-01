import { createHash } from 'node:crypto';
import { withTransaction } from '../../core/db/transaction.js';

// Event synchronization by polling (ADR-005, Parte B: no webhooks). Mandrill
// keeps events for 30 days, so they are copied locally, idempotently (a key
// derived from message, type, time and URL). Hard bounces, complaints and
// unsubscribes join the global suppression list, as does Mandrill's own
// rejection list.

const MAX_AGE_MS = 40 * 24 * 60 * 60 * 1000;
const SEARCH_LIMIT = 1000;
const STATE_EVENTS = {
  sent: 'sent', bounced: 'hard_bounce', 'soft-bounced': 'soft_bounce', rejected: 'reject', spam: 'spam', unsub: 'unsubscribe', deferred: 'deferral',
};
const SUPPRESSING = { hard_bounce: 'hard_bounce', spam: 'complaint', unsubscribe: 'unsubscribe' };
const REJECT_REASONS = { 'hard-bounce': 'hard_bounce', spam: 'complaint', unsub: 'unsubscribe' };

export const eventKey = (messageId, type, ts, url = '') => createHash('sha256').update(`${messageId}|${type}|${ts}|${url}`).digest();

// Events of one message from Mandrill's search result.
export function eventsOf(message) {
  const events = [];
  const type = STATE_EVENTS[message.state];
  if (type) events.push({ type, ts: message.ts });
  for (const open of message.opens_detail ?? []) events.push({ type: 'open', ts: open.ts });
  for (const click of message.clicks_detail ?? []) events.push({ type: 'click', ts: click.ts, url: click.url });
  return events;
}

const day = (date) => date.toISOString().slice(0, 10);

export function createSync({ pool, repository, mandrill, audit, logger, searchLimit = SEARCH_LIMIT }) {
  // messages/search answers at most `searchLimit` results: a larger
  // campaign is searched batch by batch (each batch is far below it).
  async function messagesOf(campaign) {
    const range = { dateFrom: day(campaign.started_at), dateTo: day(new Date()), limit: searchLimit };
    const all = await mandrill.search({ query: `u_campaign_id:"${campaign.id}"`, ...range });
    if (all.length < searchLimit) return all;
    const messages = [];
    for (const batchId of await repository.sentBatches(pool, campaign.id)) {
      messages.push(...await mandrill.search({ query: `u_batch_id:"${batchId}"`, ...range }));
    }
    return messages;
  }

  return {
    async run() {
      const summary = { campaigns: 0, events: 0, suppressed: 0 };
      for (const campaign of await repository.campaignsToSync(pool)) {
        let messages;
        try {
          messages = await messagesOf(campaign);
        } catch (error) {
          logger.warn({ campaignId: campaign.id, errorMessage: error.message }, 'event sync postponed');
          continue;
        }
        summary.campaigns += 1;
        await withTransaction(pool, async (client) => {
          for (const message of messages) {
            const recipient = await repository.recipientByMessage(client, message._id);
            if (!recipient || recipient.campaign_id !== campaign.id) continue;
            for (const item of eventsOf(message)) {
              const occurredAt = new Date(item.ts * 1000);
              if (Date.now() - occurredAt.getTime() > MAX_AGE_MS) continue;
              const inserted = await repository.insertEvent(client, {
                campaignId: campaign.id, recipientId: recipient.id, messageId: message._id, type: item.type, occurredAt,
                url: item.url, key: eventKey(message._id, item.type, item.ts, item.url),
              });
              if (inserted) summary.events += 1;
              if (inserted && SUPPRESSING[item.type] && await repository.suppress(client, recipient.email, SUPPRESSING[item.type])) summary.suppressed += 1;
            }
          }
        });
      }

      try {
        const rejects = await mandrill.rejects();
        await withTransaction(pool, async (client) => {
          for (const reject of rejects) {
            const reason = REJECT_REASONS[reject.reason];
            if (reason && await repository.suppress(client, reject.email, reason)) summary.suppressed += 1;
          }
        });
      } catch (error) {
        logger.warn({ errorMessage: error.message }, 'reject list sync postponed');
      }

      if (summary.events > 0 || summary.suppressed > 0) {
        await audit.record(pool, {
          actor: { type: 'system' }, action: 'sending.sync', resourceType: 'mandrill', result: 'success',
          context: { requestId: 'job:sync' }, metadata: summary,
        });
      }
      return summary;
    },
  };
}
