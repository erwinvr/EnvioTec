import { areaCondition } from '../../core/authorization/area-scope.js';

// SQL of campaigns, their PDF attachment, the recipients snapshot and test
// sends. Every read goes through the area scope (ADR-008).

const CAMPAIGN = `c.id, c.area_id, a.name AS area_name, c.name, c.status, c.subject, c.scheduled_at, c.template_version_id,
  tv.template_id, tv.version AS template_version, t.name AS template_name, c.list_id, l.name AS list_name,
  c.sender_id, s.email AS sender_email, s.display_name AS sender_name, c.attachment_id, at.original_name AS attachment_name,
  at.status AS attachment_status, at.failure_reason AS attachment_failure, c.created_by, cu.username AS created_by_username,
  c.submitted_by, su.username AS submitted_by_username, c.submitted_at, c.approved_by, au.username AS approved_by_username,
  c.approved_at, c.rejection_reason, c.cancel_reason, c.cancelled_at, c.started_at, c.finished_at, c.recipient_count,
  c.reserved, c.created_at, c.updated_at, c.schedule_variable, c.schedule_offset_days, c.schedule_time,
  c.excluded_no_date, c.excluded_past, c.excluded_too_far`;
const FROM = `FROM campaigns c
  JOIN areas a ON a.id = c.area_id
  JOIN template_versions tv ON tv.id = c.template_version_id
  JOIN templates t ON t.id = tv.template_id
  JOIN contact_lists l ON l.id = c.list_id
  JOIN sender_identities s ON s.id = c.sender_id
  JOIN users cu ON cu.id = c.created_by
  LEFT JOIN campaign_attachments at ON at.id = c.attachment_id
  LEFT JOIN users su ON su.id = c.submitted_by
  LEFT JOIN users au ON au.id = c.approved_by`;
const SUPPRESSED = "EXISTS (SELECT 1 FROM suppressions x WHERE x.email_hash = sha256(convert_to(lower(%s::text), 'UTF8')))";

export function createCampaignsRepository() {
  return {
    async list(db, scope, { status, limit, offset }) {
      const params = [];
      const conditions = [areaCondition(scope, 'c.area_id', params)];
      if (status) {
        params.push(status);
        conditions.push(`c.status = $${params.length}`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows: count } = await db.query(`SELECT count(*)::int AS total FROM campaigns c ${where}`, params);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN} ${FROM} ${where} ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    async find(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN} ${FROM} WHERE c.id = $1 AND ${areaCondition(scope, 'c.area_id', params)} ${forUpdate ? 'FOR UPDATE OF c' : ''}`,
        params,
      );
      return rows[0] ?? null;
    },

    // References of a campaign, each checked to belong to the given area.
    async references(db, areaId, { templateVersionId, listId, senderId }) {
      const { rows } = await db.query(
        `SELECT
           (SELECT row_to_json(v) FROM (SELECT tv.id, tv.status, tv.variables, t.is_archived FROM template_versions tv
              JOIN templates t ON t.id = tv.template_id WHERE tv.id = $2 AND t.area_id = $1) v) AS version,
           (SELECT row_to_json(x) FROM (SELECT id, attributes, attribute_types FROM contact_lists WHERE id = $3 AND area_id = $1) x) AS list,
           (SELECT row_to_json(y) FROM (SELECT id, is_active FROM sender_identities WHERE id = $4 AND area_id = $1) y) AS sender,
           (SELECT count(*)::int FROM contacts WHERE list_id = $3 AND anonymized_at IS NULL) AS recipients`,
        [areaId, templateVersionId, listId, senderId],
      );
      return rows[0];
    },

    async listArea(db, scope, listId) {
      const params = [listId];
      const { rows } = await db.query(`SELECT l.area_id FROM contact_lists l WHERE l.id = $1 AND ${areaCondition(scope, 'l.area_id', params)}`, params);
      return rows[0]?.area_id ?? null;
    },

    async latestReadyVersion(db, templateId, areaId) {
      const { rows } = await db.query(
        `SELECT tv.id FROM template_versions tv JOIN templates t ON t.id = tv.template_id
          WHERE tv.template_id = $1 AND t.area_id = $2 AND tv.status = 'ready' AND NOT t.is_archived
          ORDER BY tv.version DESC LIMIT 1`,
        [templateId, areaId],
      );
      return rows[0]?.id ?? null;
    },

    async create(db, input) {
      const { rows } = await db.query(
        `INSERT INTO campaigns (area_id, name, subject, template_version_id, list_id, sender_id, scheduled_at, created_by, updated_by,
                                schedule_variable, schedule_offset_days, schedule_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11) RETURNING id`,
        [input.areaId, input.name, input.subject, input.templateVersionId, input.listId, input.senderId, input.scheduledAt ?? null, input.actorId,
          input.scheduleByDate?.variable ?? null, input.scheduleByDate?.offsetDays ?? null, input.scheduleByDate?.time ?? null],
      );
      return rows[0].id;
    },

    async update(db, id, fields, actorId) {
      await db.query(
        `UPDATE campaigns SET name = $2, subject = $3, template_version_id = $4, list_id = $5, sender_id = $6, scheduled_at = $7,
                updated_by = $8, schedule_variable = $9, schedule_offset_days = $10, schedule_time = $11
          WHERE id = $1`,
        [id, fields.name, fields.subject, fields.templateVersionId, fields.listId, fields.senderId, fields.scheduledAt ?? null, actorId,
          fields.scheduleByDate?.variable ?? null, fields.scheduleByDate?.offsetDays ?? null, fields.scheduleByDate?.time ?? null],
      );
    },

    async setStatus(db, id, status, extra = {}) {
      const allowed = ['submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'rejection_reason', 'cancel_reason',
        'cancelled_at', 'cancelled_by', 'recipient_count', 'reserved', 'started_at', 'finished_at', 'scheduled_at',
        'excluded_no_date', 'excluded_past', 'excluded_too_far'];
      const entries = Object.entries(extra).filter(([key]) => allowed.includes(key));
      const sets = entries.map(([key], index) => `${key} = $${index + 3}`);
      await db.query(
        `UPDATE campaigns SET status = $2${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = $1`,
        [id, status, ...entries.map(([, value]) => value)],
      );
    },

    // Back to draft: approval data cleared and the snapshot removed.
    async resetToDraft(db, id) {
      await db.query('DELETE FROM campaign_recipients WHERE campaign_id = $1', [id]);
      await db.query(
        `UPDATE campaigns SET status = 'draft', submitted_by = NULL, submitted_at = NULL, approved_by = NULL, approved_at = NULL,
                recipient_count = NULL, reserved = 0, excluded_no_date = NULL, excluded_past = NULL, excluded_too_far = NULL,
                scheduled_at = CASE WHEN schedule_variable IS NOT NULL THEN NULL ELSE scheduled_at END
          WHERE id = $1`,
        [id],
      );
    },

    async delete(db, id) {
      await db.query('DELETE FROM campaigns WHERE id = $1', [id]);
    },

    // Approval snapshot (ADR-011): the list as it is now, minus the global
    // suppression list and anonymized contacts. Returns the count.
    async snapshotRecipients(db, campaignId, listId) {
      const { rowCount } = await db.query(
        `INSERT INTO campaign_recipients (campaign_id, contact_id, email, first_name, last_name, attributes)
         SELECT $1, c.id, c.email, c.first_name, c.last_name, c.attributes FROM contacts c
          WHERE c.list_id = $2 AND c.anonymized_at IS NULL AND NOT ${SUPPRESSED.replace('%s', 'c.email')}`,
        [campaignId, listId],
      );
      return rowCount;
    },

    // Snapshot for sending by each contact's date (ADR-030): send_at is the
    // contact's date plus the offset, at the chosen time in America/La_Paz.
    // Left out: no date, moment already past, beyond the window. Returns the
    // counts and the first send_at.
    async snapshotRecipientsByDate(db, campaignId, listId, { variable, offsetDays, time }, windowDays) {
      const params = [campaignId, listId, variable, offsetDays, time, windowDays];
      const { rows } = await db.query(
        `WITH eligible AS (
           SELECT c.id, c.email, c.first_name, c.last_name, c.attributes,
                  CASE WHEN c.attributes ->> $3 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                       THEN ((((c.attributes ->> $3)::date + $4::int) + $5::time) AT TIME ZONE 'America/La_Paz') END AS send_at
             FROM contacts c
            WHERE c.list_id = $2 AND c.anonymized_at IS NULL AND NOT ${SUPPRESSED.replace('%s', 'c.email')}
         ), inserted AS (
           INSERT INTO campaign_recipients (campaign_id, contact_id, email, first_name, last_name, attributes, send_at)
           SELECT $1, id, email, first_name, last_name, attributes, send_at FROM eligible
            WHERE send_at >= now() AND send_at <= now() + make_interval(days => $6)
           RETURNING send_at
         )
         SELECT (SELECT count(*)::int FROM inserted) AS count,
                (SELECT min(send_at) FROM inserted) AS first_send_at,
                (SELECT count(*)::int FROM eligible WHERE send_at IS NULL) AS no_date,
                (SELECT count(*)::int FROM eligible WHERE send_at < now()) AS past,
                (SELECT count(*)::int FROM eligible WHERE send_at > now() + make_interval(days => $6)) AS too_far`,
        params,
      );
      return rows[0];
    },

    async recipients(db, campaignId, { limit, offset }) {
      const { rows: count } = await db.query('SELECT count(*)::int AS total FROM campaign_recipients WHERE campaign_id = $1', [campaignId]);
      const { rows } = await db.query(
        `SELECT id, email, first_name, last_name, status, sent_at, error, send_at FROM campaign_recipients
          WHERE campaign_id = $1 ORDER BY send_at NULLS FIRST, email LIMIT $2 OFFSET $3`,
        [campaignId, limit, offset],
      );
      return { rows, total: count[0].total };
    },

    async cancelPendingRecipients(db, campaignId) {
      await db.query("UPDATE campaign_recipients SET status = 'cancelled' WHERE campaign_id = $1 AND status = 'pending'", [campaignId]);
    },

    async creatorState(db, userId) {
      const { rows } = await db.query(
        `SELECT status, deleted_at IS NULL AS present,
                (auth_source = 'ad' OR exempt_from_expiry OR expires_at > now()) AS in_validity
           FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0];
    },

    async createAttachment(db, { areaId, file, originalName, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO campaign_attachments (area_id, file_id, original_name, size_bytes, sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [areaId, file.id, originalName, file.size, file.sha256, actorId],
      );
      return rows[0].id;
    },

    async setTemplateVersion(db, campaignId, templateVersionId) {
      await db.query("UPDATE campaigns SET template_version_id = $2 WHERE id = $1 AND status = 'draft'", [campaignId, templateVersionId]);
    },

    async setAttachment(db, campaignId, attachmentId) {
      await db.query('UPDATE campaigns SET attachment_id = $2 WHERE id = $1', [campaignId, attachmentId]);
    },

    async attachment(db, id) {
      const { rows } = await db.query('SELECT id, file_id, status, original_name, sha256 FROM campaign_attachments WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async pendingAttachmentByFile(db, fileId) {
      const { rows } = await db.query(
        "SELECT id, area_id, created_by FROM campaign_attachments WHERE file_id = $1 AND status = 'pending' FOR UPDATE",
        [fileId],
      );
      return rows[0] ?? null;
    },

    async finishAttachment(db, id, { status, failureReason = null }) {
      await db.query('UPDATE campaign_attachments SET status = $2, failure_reason = $3, processed_at = now() WHERE id = $1', [id, status, failureReason]);
    },

    // Serializes the test sends of one user, so two at once cannot both pass
    // the daily limit.
    async lockTestSends(db, userId) {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('enviotec.test_send:' || $1))", [userId]);
    },

    async testSendsToday(db, userId) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM campaign_test_sends
          WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'America/La_Paz') AT TIME ZONE 'America/La_Paz'`,
        [userId],
      );
      return rows[0].n;
    },

    async createTestSend(db, { campaignId, userId, email }) {
      const { rows } = await db.query(
        'INSERT INTO campaign_test_sends (campaign_id, user_id, email) VALUES ($1, $2, $3) RETURNING id, status, created_at',
        [campaignId, userId, email],
      );
      return rows[0];
    },

    async finishTestSend(db, id, { status, messageId = null, error = null }) {
      await db.query(
        "UPDATE campaign_test_sends SET status = $2, message_id = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1",
        [id, status, messageId, error],
      );
    },

    async settings(db, keys) {
      const { rows } = await db.query('SELECT key, value FROM system_settings WHERE key = ANY($1::text[])', [keys]);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}
