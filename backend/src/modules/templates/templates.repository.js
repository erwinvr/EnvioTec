import { areaCondition } from '../../core/authorization/area-scope.js';

// SQL of templates and their versions, always within the area scope.

const TEMPLATE = `t.id, t.area_id, a.name AS area_name, t.name, t.description, t.is_archived, t.created_at, t.updated_at,
  (SELECT max(v.version) FROM template_versions v WHERE v.template_id = t.id AND v.status = 'ready') AS latest_ready`;
const VERSION = `v.id, v.template_id, v.version, v.status, v.original_name, v.size_bytes, v.sha256, v.variables, v.images,
  v.failure_reason, v.created_at, v.processed_at, u.username AS created_by_username`;

export function createTemplatesRepository() {
  return {
    async list(db, scope, { includeArchived }) {
      const params = [];
      const { rows } = await db.query(
        `SELECT ${TEMPLATE} FROM templates t JOIN areas a ON a.id = t.area_id
          WHERE ${areaCondition(scope, 't.area_id', params)} ${includeArchived ? '' : 'AND NOT t.is_archived'}
          ORDER BY a.name, t.name`,
        params,
      );
      return rows;
    },

    async find(db, scope, id, { forUpdate = false } = {}) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${TEMPLATE} FROM templates t JOIN areas a ON a.id = t.area_id
          WHERE t.id = $1 AND ${areaCondition(scope, 't.area_id', params)} ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
        params,
      );
      return rows[0] ?? null;
    },

    async findArea(db, id) {
      const { rows } = await db.query('SELECT id, is_active FROM areas WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async create(db, { areaId, name, description, actorId }) {
      const { rows } = await db.query(
        'INSERT INTO templates (area_id, name, description, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id',
        [areaId, name, description ?? '', actorId],
      );
      return rows[0].id;
    },

    async update(db, id, changes, actorId) {
      await db.query(
        `UPDATE templates SET name = CASE WHEN $2 THEN $3 ELSE name END,
                              description = CASE WHEN $4 THEN $5 ELSE description END,
                              is_archived = CASE WHEN $6 THEN $7 ELSE is_archived END, updated_by = $8
          WHERE id = $1`,
        [id, 'name' in changes, changes.name ?? null, 'description' in changes, changes.description ?? null,
          'isArchived' in changes, changes.isArchived ?? null, actorId],
      );
    },

    async versions(db, templateId) {
      const { rows } = await db.query(
        `SELECT ${VERSION} FROM template_versions v JOIN users u ON u.id = v.created_by
          WHERE v.template_id = $1 ORDER BY v.version DESC`,
        [templateId],
      );
      return rows;
    },

    async version(db, templateId, version) {
      const { rows } = await db.query(
        `SELECT ${VERSION}, v.html, v.text_body FROM template_versions v JOIN users u ON u.id = v.created_by
          WHERE v.template_id = $1 AND v.version = $2`,
        [templateId, version],
      );
      return rows[0] ?? null;
    },

    // The template row is locked by the caller, so numbers never collide.
    async createVersion(db, { templateId, file, originalName, actorId }) {
      const { rows } = await db.query(
        `INSERT INTO template_versions (template_id, version, file_id, original_name, size_bytes, sha256, created_by)
         VALUES ($1, coalesce((SELECT max(version) FROM template_versions WHERE template_id = $1), 0) + 1, $2, $3, $4, $5, $6)
         RETURNING id, version`,
        [templateId, file.id, originalName, file.size, file.sha256, actorId],
      );
      return rows[0];
    },

    async pendingVersionByFile(db, fileId) {
      const { rows } = await db.query(
        `SELECT v.id, v.template_id, v.version, v.created_by FROM template_versions v
          WHERE v.file_id = $1 AND v.status = 'pending' FOR UPDATE`,
        [fileId],
      );
      return rows[0] ?? null;
    },

    async finishVersion(db, id, { status, html = null, text = null, variables = [], images = [], failureReason = null }) {
      await db.query(
        `UPDATE template_versions SET status = $2, html = $3, text_body = $4, variables = $5, images = $6::jsonb,
                failure_reason = $7, processed_at = now()
          WHERE id = $1`,
        [id, status, html, text, variables, JSON.stringify(images), failureReason],
      );
    },
  };
}
