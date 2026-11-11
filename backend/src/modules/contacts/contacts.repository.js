import { areaCondition } from '../../core/authorization/area-scope.js';
import { escapeLike } from '../../core/db/sql.js';

// SQL of lists, contacts and imports. Every read and every target of a
// change goes through the area scope (ADR-008).

const LIST_COLUMNS = `l.id, l.area_id, a.name AS area_name, l.name, l.description, l.attributes, l.attribute_labels, l.attribute_types, l.created_at, l.updated_at,
  (SELECT count(*)::int FROM contacts c WHERE c.list_id = l.id) AS contact_count`;
const CONTACT_COLUMNS = 'c.id, c.list_id, c.email, c.first_name, c.last_name, c.attributes, c.anonymized_at, c.created_at, c.updated_at';
const IMPORT_COLUMNS = `i.id, i.list_id, i.original_name, i.size_bytes, i.sha256, i.status, i.total_rows, i.inserted, i.updated,
  i.rejected, i.errors, i.failure_reason, i.created_at, i.finished_at, i.header, i.sample, i.mapping, i.file_id, i.area_id,
  u.username AS created_by_username`;

export function createContactsRepository() {
  return {
    async lists(db, scope) {
      const params = [];
      const { rows } = await db.query(
        `SELECT ${LIST_COLUMNS} FROM contact_lists l JOIN areas a ON a.id = l.area_id
          WHERE ${areaCondition(scope, 'l.area_id', params)} ORDER BY a.name, l.name`,
        params,
      );
      return rows;
    },

    async list(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${LIST_COLUMNS} FROM contact_lists l JOIN areas a ON a.id = l.area_id
          WHERE l.id = $1 AND ${areaCondition(scope, 'l.area_id', params)} ${forUpdate ? 'FOR UPDATE OF l' : ''}`,
        params,
      );
      return rows[0] ?? null;
    },

    async findArea(db, id) {
      const { rows } = await db.query('SELECT id, is_active FROM areas WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    // `variables`: [{ name, label }] in order (ADR-028).
    async createList(db, { areaId, name, description, variables, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO contact_lists (area_id, name, description, attributes, attribute_labels, attribute_types, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [areaId, name, description ?? '', variables.map((v) => v.name), Object.fromEntries(variables.map((v) => [v.name, v.label])),
          Object.fromEntries(variables.map((v) => [v.name, v.type ?? 'text'])), actorId],
      );
      return rows[0].id;
    },

    async updateList(db, id, changes, actorId) {
      await db.query(
        `UPDATE contact_lists SET
            name = CASE WHEN $2 THEN $3 ELSE name END,
            description = CASE WHEN $4 THEN $5 ELSE description END,
            updated_by = $6
          WHERE id = $1`,
        [id, 'name' in changes, changes.name ?? null, 'description' in changes, changes.description ?? null, actorId],
      );
    },

    async addVariable(db, id, { name, label, type }, actorId) {
      await db.query(
        `UPDATE contact_lists SET attributes = array_append(attributes, $2), attribute_labels = attribute_labels || jsonb_build_object($2::text, $3::text),
                attribute_types = attribute_types || jsonb_build_object($2::text, $5::text), updated_by = $4
          WHERE id = $1`,
        [id, name, label, actorId, type ?? 'text'],
      );
    },

    async setVariableLabel(db, id, name, label, actorId) {
      await db.query(
        'UPDATE contact_lists SET attribute_labels = attribute_labels || jsonb_build_object($2::text, $3::text), updated_by = $4 WHERE id = $1',
        [id, name, label, actorId],
      );
    },

    async removeVariable(db, id, name, actorId) {
      await db.query(
        `UPDATE contact_lists SET attributes = array_remove(attributes, $2), attribute_labels = attribute_labels - $2::text,
                attribute_types = attribute_types - $2::text, updated_by = $3
          WHERE id = $1`,
        [id, name, actorId],
      );
    },

    // A variable with data cannot be removed (ADR-028).
    async variableInUse(db, listId, name) {
      const { rows } = await db.query(
        "SELECT EXISTS (SELECT 1 FROM contacts WHERE list_id = $1 AND attributes ? $2 AND attributes ->> $2 <> '') AS used",
        [listId, name],
      );
      return rows[0].used;
    },

    async contacts(db, listId, { search, limit, offset }) {
      const params = [listId];
      let where = 'WHERE c.list_id = $1';
      if (search) {
        params.push(`%${escapeLike(search)}%`);
        where += ` AND (c.email ILIKE $2 OR c.first_name ILIKE $2 OR c.last_name ILIKE $2)`;
      }
      const { rows: count } = await db.query(`SELECT count(*)::int AS total FROM contacts c ${where}`, params);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT ${CONTACT_COLUMNS},
                EXISTS (SELECT 1 FROM suppressions s WHERE s.email_hash = sha256(convert_to(lower(c.email::text), 'UTF8'))) AS suppressed
           FROM contacts c ${where}
          ORDER BY c.email LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    async contactInScope(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${CONTACT_COLUMNS}, l.attributes AS list_attributes, l.attribute_types AS list_types FROM contacts c JOIN contact_lists l ON l.id = c.list_id
          WHERE c.id = $1 AND ${areaCondition(scope, 'c.area_id', params)} ${forUpdate ? 'FOR UPDATE OF c' : ''}`,
        params,
      );
      return rows[0] ?? null;
    },

    async createContact(db, { areaId, listId, contact, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO contacts (area_id, list_id, email, first_name, last_name, attributes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [areaId, listId, contact.email, contact.first_name, contact.last_name, contact.attributes, actorId],
      );
      return rows[0].id;
    },

    async updateContact(db, id, contact) {
      await db.query(
        'UPDATE contacts SET email = $2, first_name = $3, last_name = $4, attributes = $5 WHERE id = $1 AND anonymized_at IS NULL',
        [id, contact.email, contact.first_name, contact.last_name, contact.attributes],
      );
    },

    async deleteContact(db, id) {
      await db.query('DELETE FROM contacts WHERE id = $1', [id]);
    },

    // Upserts a batch of validated rows (deduplication by list and email).
    // Returns how many were inserted and how many updated.
    async upsertContacts(db, { areaId, listId, rows, actorId }) {
      const { rows: result } = await db.query(
        `INSERT INTO contacts (area_id, list_id, email, first_name, last_name, attributes, created_by)
         SELECT $1, $2, r.email, r.first_name, r.last_name, r.attributes, $4
           FROM jsonb_to_recordset($3::jsonb) AS r(email citext, first_name text, last_name text, attributes jsonb)
         ON CONFLICT (list_id, email) DO UPDATE
           SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, attributes = EXCLUDED.attributes
           WHERE contacts.anonymized_at IS NULL
         RETURNING (xmax = 0) AS inserted`,
        [areaId, listId, JSON.stringify(rows), actorId],
      );
      const inserted = result.filter((row) => row.inserted).length;
      return { inserted, updated: result.length - inserted };
    },

    async *exportRows(db, listId) {
      let after = '';
      for (;;) {
        const { rows } = await db.query(
          `SELECT email, first_name, last_name, attributes FROM contacts
            WHERE list_id = $1 AND anonymized_at IS NULL AND email > $2 ORDER BY email LIMIT 1000`,
          [listId, after],
        );
        if (rows.length === 0) return;
        yield rows;
        after = rows.at(-1).email;
      }
    },

    // An import starts waiting for its column mapping (ADR-028).
    async createImport(db, { areaId, listId, file, originalName, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO contact_imports (area_id, list_id, file_id, original_name, size_bytes, sha256, created_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'awaiting_mapping') RETURNING id`,
        [areaId, listId, file.id, originalName, file.size, file.sha256, actorId],
      );
      return rows[0].id;
    },

    async imports(db, listId) {
      const { rows } = await db.query(
        `SELECT ${IMPORT_COLUMNS} FROM contact_imports i JOIN users u ON u.id = i.created_by
          WHERE i.list_id = $1 ORDER BY i.created_at DESC LIMIT 50`,
        [listId],
      );
      return rows;
    },

    async importInScope(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${IMPORT_COLUMNS} FROM contact_imports i JOIN users u ON u.id = i.created_by
          WHERE i.id = $1 AND ${areaCondition(scope, 'i.area_id', params)} ${forUpdate ? 'FOR UPDATE OF i' : ''}`,
        params,
      );
      return rows[0] ?? null;
    },

    // For the worker: the import whose preview is pending, locked.
    async previewImportByFile(db, fileId) {
      const { rows } = await db.query(
        "SELECT id, area_id, list_id, created_by FROM contact_imports WHERE file_id = $1 AND status = 'awaiting_mapping' AND header IS NULL FOR UPDATE",
        [fileId],
      );
      return rows[0] ?? null;
    },

    async setPreview(db, id, { header, sample }) {
      await db.query('UPDATE contact_imports SET header = $2::jsonb, sample = $3::jsonb WHERE id = $1', [id, JSON.stringify(header), JSON.stringify(sample)]);
    },

    // The mapping is kept; the sample (personal data) is no longer needed.
    async startMapping(db, id, mapping) {
      await db.query("UPDATE contact_imports SET status = 'pending', mapping = $2::jsonb, sample = NULL WHERE id = $1", [id, JSON.stringify(mapping)]);
    },

    async expiredAwaitingImports(db, hours) {
      const { rows } = await db.query(
        `SELECT id, file_id, list_id, created_by FROM contact_imports
          WHERE status = 'awaiting_mapping' AND created_at < now() - make_interval(hours => $1) FOR UPDATE SKIP LOCKED`,
        [hours],
      );
      return rows;
    },

    // For the worker: the pending import with this file, locked.
    async pendingImportByFile(db, fileId) {
      const { rows } = await db.query(
        "SELECT id, area_id, list_id, created_by FROM contact_imports WHERE file_id = $1 AND status = 'pending' FOR UPDATE",
        [fileId],
      );
      return rows[0] ?? null;
    },

    async finishImport(db, id, { status, totalRows = null, inserted = null, updated = null, rejected = null, errors = [], failureReason = null }) {
      await db.query(
        `UPDATE contact_imports SET status = $2, total_rows = $3, inserted = $4, updated = $5, rejected = $6,
                errors = $7::jsonb, failure_reason = $8, finished_at = now(), sample = NULL
          WHERE id = $1`,
        [id, status, totalRows, inserted, updated, rejected, JSON.stringify(errors), failureReason],
      );
    },
  };
}
