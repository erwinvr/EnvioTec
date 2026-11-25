import { isIP } from 'node:net';
import { emailHash } from '../suppressions/suppressions.repository.js';

// SQL of the event synchronization with Mandrill (ADR-005, ADR-029). Runs in
// the worker; nothing here is reachable from HTTP.

// Only a well-formed IPv4 or IPv6 address reaches the ip column.
const validIp = (ip) => (typeof ip === 'string' && isIP(ip) !== 0 ? ip : null);

export function createSyncRepository() {
  return {
    async campaignsToSync(db) {
      const { rows } = await db.query(
        `SELECT id, started_at FROM campaigns
          WHERE started_at IS NOT NULL AND started_at > DATEADD(day, -30, SYSUTCDATETIME()) ORDER BY started_at`,
      );
      return rows;
    },

    async sentBatches(db, campaignId) {
      const { rows } = await db.query("SELECT id FROM send_batches WHERE campaign_id = $1 AND status = 'accepted' AND accepted > 0 ORDER BY id", [campaignId]);
      return rows.map((row) => row.id);
    },

    async recipientByMessage(db, messageId) {
      const { rows } = await db.query('SELECT id, campaign_id, email FROM campaign_recipients WHERE message_id = $1', [messageId]);
      return rows[0] ?? null;
    },

    // Idempotent by key; an event stored without details (before ADR-029)
    // gets them the next time it is seen. Returns true only when inserted.
    // HOLDLOCK on the existence check keeps two syncs from inserting twice.
    async insertEvent(db, event) {
      const details = [validIp(event.ip), event.location?.slice(0, 200) ?? null, event.userAgent?.slice(0, 500) ?? null,
        event.device ?? null, event.os ?? null, event.client ?? null];
      const { rowCount } = await db.query(
        `IF NOT EXISTS (SELECT 1 FROM message_events WITH (UPDLOCK, HOLDLOCK) WHERE idempotency_key = $7 AND occurred_at = $5)
           INSERT INTO message_events (campaign_id, recipient_id, message_id, event_type, occurred_at, url, idempotency_key,
                                       ip, location, user_agent, device, os, client)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [event.campaignId, event.recipientId, event.messageId, event.type, event.occurredAt, event.url ?? null, event.key, ...details],
      );
      if (rowCount === 1) return true;
      if (details.slice(0, 3).some((value) => value !== null)) {
        await db.query(
          `UPDATE message_events SET ip = $3, location = $4, user_agent = $5, device = $6, os = $7, client = $8
            WHERE idempotency_key = $1 AND occurred_at = $2 AND ip IS NULL AND location IS NULL AND user_agent IS NULL`,
          [event.key, event.occurredAt, ...details],
        );
      }
      return false;
    },

    // Message ids of the accepted recipients, those without any event first.
    async sentMessageIds(db, campaignId) {
      const { rows } = await db.query(
        `SELECT r.message_id FROM campaign_recipients r
          WHERE r.campaign_id = $1 AND r.status = 'sent' AND r.message_id IS NOT NULL
          ORDER BY CASE WHEN EXISTS (SELECT 1 FROM message_events e WHERE e.recipient_id = r.id) THEN 1 ELSE 0 END, r.sent_at DESC`,
        [campaignId],
      );
      return rows.map((row) => row.message_id);
    },

    // Bounces, complaints and unsubscribes join the global suppression list.
    async suppress(db, email, reason) {
      const { rowCount } = await db.query(
        `IF NOT EXISTS (SELECT 1 FROM suppressions WITH (UPDLOCK, HOLDLOCK) WHERE email_hash = $1)
           INSERT INTO suppressions (email_hash, email, reason, source) VALUES ($1, $2, $3, 'mandrill')`,
        [emailHash(email), email.toLowerCase(), reason],
      );
      return rowCount === 1;
    },
  };
}
