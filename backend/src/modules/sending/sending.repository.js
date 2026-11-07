import { isIP } from 'node:net';

// SQL of the sender and the event synchronization (ADR-005, ADR-024). Runs
// in the worker; nothing here is reachable from HTTP.

// Only a well-formed IPv4 or IPv6 address reaches the inet column.
const validIp = (ip) => (typeof ip === 'string' && isIP(ip) !== 0 ? ip : null);

const SUPPRESSED = "EXISTS (SELECT 1 FROM suppressions x WHERE x.email_hash = sha256(convert_to(lower(r.email::text), 'UTF8')))";

export function createSendingRepository() {
  return {
    // Campaigns whose time has come: approved without a schedule, or with
    // the scheduled time already reached.
    async dueCampaigns(db) {
      const { rows } = await db.query(
        `SELECT id FROM campaigns
          WHERE status IN ('approved', 'scheduled') AND (scheduled_at IS NULL OR scheduled_at <= now())
          ORDER BY approved_at LIMIT 20`,
      );
      return rows.map((row) => row.id);
    },

    async lockCampaign(db, id) {
      const { rows } = await db.query(
        `SELECT c.id, c.status, c.created_by, c.reserved, c.subject, c.template_version_id, c.sender_id, c.attachment_id, c.area_id
           FROM campaigns c WHERE c.id = $1 FOR UPDATE`,
        [id],
      );
      return rows[0] ?? null;
    },

    async startCampaign(db, id) {
      await db.query("UPDATE campaigns SET status = 'sending', started_at = coalesce(started_at, now()) WHERE id = $1", [id]);
    },

    // Groups the pending recipients without a batch into batches of `size`.
    async createBatches(db, campaignId, size) {
      const batches = [];
      for (;;) {
        const { rows } = await db.query(
          "SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending' AND batch_id IS NULL ORDER BY id LIMIT $2",
          [campaignId, size],
        );
        if (rows.length === 0) return batches;
        const { rows: batch } = await db.query('INSERT INTO send_batches (campaign_id, size) VALUES ($1, $2) RETURNING id', [campaignId, rows.length]);
        await db.query('UPDATE campaign_recipients SET batch_id = $1 WHERE id = ANY($2::uuid[])', [batch[0].id, rows.map((row) => row.id)]);
        batches.push(batch[0].id);
      }
    },

    // Pending batches to queue: new ones at once; one put back after a
    // provider error (or a lost job) with exponential backoff, 5, 10, 20,
    // 40 and then 60 minutes (T34). Marks them as queued now.
    async batchesToQueue(db, campaignId) {
      const { rows } = await db.query(
        `UPDATE send_batches SET queued_at = now()
          WHERE campaign_id = $1 AND status = 'pending'
            AND (queued_at IS NULL OR queued_at < now() - make_interval(mins => least(60, 5 * power(2, attempts)::int)))
          RETURNING id`,
        [campaignId],
      );
      return rows.map((row) => row.id);
    },

    async ambiguousBatches(db) {
      const { rows } = await db.query(
        // Older than the delay of Mandrill's search index (ADR-029).
        "SELECT id, campaign_id FROM send_batches WHERE status = 'ambiguous' AND updated_at < now() - interval '60 minutes' LIMIT 50",
      );
      return rows;
    },

    async sendingCampaigns(db) {
      const { rows } = await db.query("SELECT id FROM campaigns WHERE status = 'sending'");
      return rows.map((row) => row.id);
    },

    async openBatches(db, campaignId) {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM send_batches WHERE campaign_id = $1 AND status IN ('pending', 'in_flight', 'ambiguous')",
        [campaignId],
      );
      return rows[0].n;
    },

    async completeCampaign(db, id) {
      await db.query("UPDATE campaigns SET status = 'completed', finished_at = now(), reserved = 0 WHERE id = $1", [id]);
    },

    async pauseCampaign(db, id) {
      await db.query("UPDATE campaigns SET status = 'paused' WHERE id = $1 AND status = 'sending'", [id]);
    },

    async addReserved(db, id, delta) {
      await db.query('UPDATE campaigns SET reserved = reserved + $2 WHERE id = $1', [id, delta]);
    },

    async lockBatch(db, id) {
      const { rows } = await db.query('SELECT id, campaign_id, status, attempts FROM send_batches WHERE id = $1 FOR UPDATE', [id]);
      return rows[0] ?? null;
    },

    async setBatch(db, id, fields) {
      await db.query(
        `UPDATE send_batches SET status = $2, attempts = attempts + $3, accepted = coalesce($4, accepted), rejected = coalesce($5, rejected),
                error = $6, sent_at = CASE WHEN $2 = 'accepted' THEN now() ELSE sent_at END
          WHERE id = $1`,
        [id, fields.status, fields.attempt ? 1 : 0, fields.accepted ?? null, fields.rejected ?? null, fields.error ?? null],
      );
    },

    // Suppression is applied again on every batch (Parte B): it can only
    // remove recipients. Returns how many were removed.
    async suppressBatch(db, batchId) {
      const { rowCount } = await db.query(
        `UPDATE campaign_recipients r SET status = 'suppressed'
          WHERE r.batch_id = $1 AND r.status IN ('pending', 'sending') AND ${SUPPRESSED}`,
        [batchId],
      );
      return rowCount;
    },

    async batchRecipients(db, batchId, statuses) {
      const { rows } = await db.query(
        `SELECT id, email, first_name, last_name, attributes FROM campaign_recipients
          WHERE batch_id = $1 AND status = ANY($2::text[]) ORDER BY id`,
        [batchId, statuses],
      );
      return rows;
    },

    async markRecipients(db, batchId, from, to) {
      await db.query('UPDATE campaign_recipients SET status = $3 WHERE batch_id = $1 AND status = $2', [batchId, from, to]);
    },

    async recordResults(db, batchId, results) {
      await db.query(
        `UPDATE campaign_recipients r SET status = x.status, message_id = x.message_id, error = x.error,
                sent_at = CASE WHEN x.status = 'sent' THEN now() END
           FROM jsonb_to_recordset($2::jsonb) AS x(email text, status text, message_id text, error text)
          WHERE r.batch_id = $1 AND lower(r.email::text) = lower(x.email) AND r.status = 'sending'`,
        [batchId, JSON.stringify(results)],
      );
    },

    // Content of a campaign for building messages.
    async content(db, campaign) {
      const { rows } = await db.query(
        `SELECT tv.html, tv.text_body, tv.variables, tv.images,
                s.email AS sender_email, s.display_name, s.reply_to, s.is_active AS sender_active,
                a.file_id AS attachment_file, a.original_name AS attachment_name, a.status AS attachment_status
           FROM template_versions tv
           JOIN sender_identities s ON s.id = $2
           LEFT JOIN campaign_attachments a ON a.id = $3
          WHERE tv.id = $1`,
        [campaign.template_version_id, campaign.sender_id, campaign.attachment_id],
      );
      return rows[0] ?? null;
    },

    async lockTestSend(db, id) {
      const { rows } = await db.query(
        `SELECT t.id, t.status, t.email, t.campaign_id, c.subject, c.template_version_id, c.sender_id, c.attachment_id
           FROM campaign_test_sends t JOIN campaigns c ON c.id = t.campaign_id WHERE t.id = $1 FOR UPDATE OF t`,
        [id],
      );
      return rows[0] ?? null;
    },

    async finishTestSend(db, id, { status, messageId = null, error = null }) {
      await db.query(
        "UPDATE campaign_test_sends SET status = $2, message_id = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1",
        [id, status, messageId, error],
      );
    },

    // --- Synchronization

    async campaignsToSync(db) {
      const { rows } = await db.query(
        `SELECT id, started_at FROM campaigns
          WHERE started_at IS NOT NULL AND started_at > now() - interval '30 days' ORDER BY started_at`,
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
    // (message_events is partitioned: no xmax, so insert and fill are two steps.)
    async insertEvent(db, event) {
      const details = [validIp(event.ip), event.location?.slice(0, 200) ?? null, event.userAgent?.slice(0, 500) ?? null,
        event.device ?? null, event.os ?? null, event.client ?? null];
      const { rowCount } = await db.query(
        `INSERT INTO message_events (campaign_id, recipient_id, message_id, event_type, occurred_at, url, idempotency_key,
                                     ip, location, user_agent, device, os, client)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9, $10, $11, $12, $13)
         ON CONFLICT (idempotency_key, occurred_at) DO NOTHING`,
        [event.campaignId, event.recipientId, event.messageId, event.type, event.occurredAt, event.url ?? null, event.key, ...details],
      );
      if (rowCount === 1) return true;
      if (details.slice(0, 3).some((value) => value !== null)) {
        await db.query(
          `UPDATE message_events SET ip = $3::inet, location = $4, user_agent = $5, device = $6, os = $7, client = $8
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
          ORDER BY EXISTS (SELECT 1 FROM message_events e WHERE e.recipient_id = r.id), r.sent_at DESC`,
        [campaignId],
      );
      return rows.map((row) => row.message_id);
    },

    // Bounces, complaints and unsubscribes join the global suppression list.
    async suppress(db, email, reason) {
      const { rowCount } = await db.query(
        `INSERT INTO suppressions (email_hash, email, reason, source)
         VALUES (sha256(convert_to(lower($1::text), 'UTF8')), lower($1::text), $2, 'mandrill')
         ON CONFLICT (email_hash) DO NOTHING`,
        [email, reason],
      );
      return rowCount === 1;
    },

    async settings(db, keys) {
      const { rows } = await db.query('SELECT key, value FROM system_settings WHERE key = ANY($1::text[])', [keys]);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}
