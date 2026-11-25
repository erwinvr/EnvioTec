import { areaCondition } from '../../core/authorization/area-scope.js';
import { LA_PAZ_TODAY, fromLaPaz, inJson, page } from '../../core/db/sql.js';
import { lockName } from '../../core/db/transaction.js';

// SQL of campaigns, their PDF attachment, the recipients snapshot and test
// sends. Every read goes through the area scope (ADR-008).

const CAMPAIGN = `c.id, c.area_id, a.name AS area_name, c.name, c.status, c.subject, c.scheduled_at, c.template_version_id,
  tv.template_id, tv.version AS template_version, t.name AS template_name, c.list_id, l.name AS list_name,
  c.sender_id, s.email AS sender_email, s.display_name AS sender_name, c.attachment_id, at.original_name AS attachment_name,
  at.status AS attachment_status, at.failure_reason AS attachment_failure, c.created_by, cu.username AS created_by_username,
  c.submitted_by, su.username AS submitted_by_username, c.submitted_at, c.approved_by, au.username AS approved_by_username,
  c.approved_at, c.rejection_reason, c.cancel_reason, c.cancelled_at, c.started_at, c.finished_at, c.recipient_count,
  c.reserved, c.created_at, c.updated_at, c.schedule_variable, c.schedule_offset_days,
  CONVERT(char(5), c.schedule_time, 108) AS schedule_time,
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
// The global suppression list, matched by the hash of the address.
const SUPPRESSED = 'EXISTS (SELECT 1 FROM suppressions x WHERE x.email_hash = c.email_hash)';
// One row as a JSON object (row_to_json in PostgreSQL), parsed here.
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value ?? null);
const GUID = (column) => `LOWER(CONVERT(nvarchar(36), ${column}))`;

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
      const { rows: count } = await db.query(`SELECT COUNT(*) AS total FROM campaigns c ${where}`, params);
      params.push(offset, limit);
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN} ${FROM} ${where} ORDER BY c.created_at DESC ${page(`$${params.length - 1}`, `$${params.length}`)}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    async find(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN} ${FROM.replace('FROM campaigns c', `FROM campaigns c ${forUpdate ? 'WITH (UPDLOCK, ROWLOCK)' : ''}`)}
          WHERE c.id = $1 AND ${areaCondition(scope, 'c.area_id', params)}`,
        params,
      );
      return rows[0] ?? null;
    },

    // References of a campaign, each checked to belong to the given area.
    async references(db, areaId, { templateVersionId, listId, senderId }) {
      const { rows } = await db.query(
        `SELECT
           (SELECT ${GUID('tv.id')} AS id, tv.status, JSON_QUERY(tv.variables) AS variables, t.is_archived
              FROM template_versions tv JOIN templates t ON t.id = tv.template_id
             WHERE tv.id = $2 AND t.area_id = $1 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS version_json,
           (SELECT ${GUID('id')} AS id, JSON_QUERY(attributes) AS attributes, JSON_QUERY(attribute_types) AS attribute_types
              FROM contact_lists WHERE id = $3 AND area_id = $1 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS list_json,
           (SELECT ${GUID('id')} AS id, is_active FROM sender_identities
             WHERE id = $4 AND area_id = $1 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS sender_json,
           (SELECT COUNT(*) FROM contacts WHERE list_id = $3 AND anonymized_at IS NULL) AS recipients`,
        [areaId, templateVersionId, listId, senderId],
      );
      const row = rows[0];
      return { version: json(row.version_json), list: json(row.list_json), sender: json(row.sender_json), recipients: row.recipients };
    },

    async listArea(db, scope, listId) {
      const params = [listId];
      const { rows } = await db.query(`SELECT l.area_id FROM contact_lists l WHERE l.id = $1 AND ${areaCondition(scope, 'l.area_id', params)}`, params);
      return rows[0]?.area_id ?? null;
    },

    async latestReadyVersion(db, templateId, areaId) {
      const { rows } = await db.query(
        `SELECT TOP (1) tv.id FROM template_versions tv JOIN templates t ON t.id = tv.template_id
          WHERE tv.template_id = $1 AND t.area_id = $2 AND tv.status = 'ready' AND t.is_archived = 0
          ORDER BY tv.version DESC`,
        [templateId, areaId],
      );
      return rows[0]?.id ?? null;
    },

    async create(db, input) {
      const { rows } = await db.query(
        `INSERT INTO campaigns (area_id, name, subject, template_version_id, list_id, sender_id, scheduled_at, created_by, updated_by,
                                schedule_variable, schedule_offset_days, schedule_time)
         OUTPUT inserted.id
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)`,
        [input.areaId, input.name, input.subject, input.templateVersionId, input.listId, input.senderId, input.scheduledAt ?? null, input.actorId,
          input.scheduleByDate?.variable ?? null, input.scheduleByDate?.offsetDays ?? null, input.scheduleByDate?.time ?? null],
      );
      return rows[0].id;
    },

    async update(db, id, fields, actorId) {
      await db.query(
        `UPDATE campaigns SET name = $2, subject = $3, template_version_id = $4, list_id = $5, sender_id = $6, scheduled_at = $7,
                updated_by = $8, schedule_variable = $9, schedule_offset_days = $10, schedule_time = $11,
                updated_at = SYSUTCDATETIME()
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
        `UPDATE campaigns SET status = $2, updated_at = SYSUTCDATETIME()${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = $1`,
        [id, status, ...entries.map(([, value]) => value)],
      );
    },

    // Back to draft: approval data cleared and the snapshot removed.
    async resetToDraft(db, id) {
      await db.query('DELETE FROM campaign_recipients WHERE campaign_id = $1', [id]);
      await db.query(
        `UPDATE campaigns SET status = 'draft', submitted_by = NULL, submitted_at = NULL, approved_by = NULL, approved_at = NULL,
                recipient_count = NULL, reserved = 0, excluded_no_date = NULL, excluded_past = NULL, excluded_too_far = NULL,
                scheduled_at = CASE WHEN schedule_variable IS NOT NULL THEN NULL ELSE scheduled_at END,
                updated_at = SYSUTCDATETIME()
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
          WHERE c.list_id = $2 AND c.anonymized_at IS NULL AND NOT ${SUPPRESSED}`,
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
        `DECLARE @eligible TABLE (contact_id uniqueidentifier PRIMARY KEY, send_at datetime2(3) NULL);
         DECLARE @now datetime2(3) = SYSUTCDATETIME();
         DECLARE @limit datetime2(3) = DATEADD(day, $6, @now);
         INSERT INTO @eligible (contact_id, send_at)
         SELECT c.id,
                CASE WHEN d.value LIKE '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND TRY_CAST(d.value AS date) IS NOT NULL
                     THEN ${fromLaPaz(`DATEADD(second, DATEDIFF(second, CAST('00:00' AS time), CAST($5 AS time)),
                                         DATEADD(day, $4, CAST(TRY_CAST(d.value AS date) AS datetime2(3))))`)} END
           FROM contacts c
           CROSS APPLY (SELECT JSON_VALUE(c.attributes, CONCAT('$."', $3, '"')) AS value) d
          WHERE c.list_id = $2 AND c.anonymized_at IS NULL AND NOT ${SUPPRESSED};
         INSERT INTO campaign_recipients (campaign_id, contact_id, email, first_name, last_name, attributes, send_at)
         SELECT $1, c.id, c.email, c.first_name, c.last_name, c.attributes, e.send_at
           FROM @eligible e JOIN contacts c ON c.id = e.contact_id
          WHERE e.send_at >= @now AND e.send_at <= @limit;
         SELECT COUNT(CASE WHEN send_at >= @now AND send_at <= @limit THEN 1 END) AS count,
                MIN(CASE WHEN send_at >= @now AND send_at <= @limit THEN send_at END) AS first_send_at,
                COUNT(CASE WHEN send_at IS NULL THEN 1 END) AS no_date,
                COUNT(CASE WHEN send_at < @now THEN 1 END) AS past,
                COUNT(CASE WHEN send_at > @limit THEN 1 END) AS too_far
           FROM @eligible;`,
        params,
      );
      return rows[0];
    },

    async recipients(db, campaignId, { limit, offset }) {
      const { rows: count } = await db.query('SELECT COUNT(*) AS total FROM campaign_recipients WHERE campaign_id = $1', [campaignId]);
      const { rows } = await db.query(
        `SELECT id, email, first_name, last_name, status, sent_at, error, send_at FROM campaign_recipients
          WHERE campaign_id = $1 ORDER BY send_at, email ${page('$2', '$3')}`,
        [campaignId, offset, limit],
      );
      return { rows, total: count[0].total };
    },

    async cancelPendingRecipients(db, campaignId) {
      await db.query("UPDATE campaign_recipients SET status = 'cancelled' WHERE campaign_id = $1 AND status = 'pending'", [campaignId]);
    },

    async creatorState(db, userId) {
      const { rows } = await db.query(
        `SELECT status, CAST(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END AS bit) AS present,
                CAST(CASE WHEN auth_source = 'ad' OR exempt_from_expiry = 1 OR expires_at > SYSUTCDATETIME() THEN 1 ELSE 0 END AS bit)
                  AS in_validity
           FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0];
    },

    async createAttachment(db, { areaId, file, originalName, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO campaign_attachments (area_id, file_id, original_name, size_bytes, sha256, created_by)
         OUTPUT inserted.id
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [areaId, file.id, originalName, file.size, file.sha256, actorId],
      );
      return rows[0].id;
    },

    async setTemplateVersion(db, campaignId, templateVersionId) {
      await db.query(
        "UPDATE campaigns SET template_version_id = $2, updated_at = SYSUTCDATETIME() WHERE id = $1 AND status = 'draft'",
        [campaignId, templateVersionId],
      );
    },

    async setAttachment(db, campaignId, attachmentId) {
      await db.query('UPDATE campaigns SET attachment_id = $2, updated_at = SYSUTCDATETIME() WHERE id = $1', [campaignId, attachmentId]);
    },

    async attachment(db, id) {
      const { rows } = await db.query('SELECT id, file_id, status, original_name, sha256 FROM campaign_attachments WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async pendingAttachmentByFile(db, fileId) {
      const { rows } = await db.query(
        "SELECT id, area_id, created_by FROM campaign_attachments WITH (UPDLOCK, ROWLOCK) WHERE file_id = $1 AND status = 'pending'",
        [fileId],
      );
      return rows[0] ?? null;
    },

    async finishAttachment(db, id, { status, failureReason = null }) {
      await db.query('UPDATE campaign_attachments SET status = $2, failure_reason = $3, processed_at = SYSUTCDATETIME() WHERE id = $1', [id, status, failureReason]);
    },

    // Serializes the test sends of one user, so two at once cannot both pass
    // the daily limit.
    async lockTestSends(db, userId) {
      await lockName(db, `enviotec.test_send:${userId}`);
    },

    async testSendsToday(db, userId) {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS n FROM campaign_test_sends
          WHERE user_id = $1 AND created_at >= ${fromLaPaz(LA_PAZ_TODAY)}`,
        [userId],
      );
      return rows[0].n;
    },

    async createTestSend(db, { campaignId, userId, email }) {
      const { rows } = await db.query(
        'INSERT INTO campaign_test_sends (campaign_id, user_id, email) OUTPUT inserted.id, inserted.status, inserted.created_at VALUES ($1, $2, $3)',
        [campaignId, userId, email],
      );
      return rows[0];
    },

    async finishTestSend(db, id, { status, messageId = null, error = null }) {
      await db.query(
        "UPDATE campaign_test_sends SET status = $2, message_id = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN SYSUTCDATETIME() END WHERE id = $1",
        [id, status, messageId, error],
      );
    },

    async settings(db, keys) {
      const { rows } = await db.query(`SELECT [key], value FROM system_settings WHERE [key] IN ${inJson('$1')}`, [keys]);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}
