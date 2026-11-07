// Authorization matrix (A12) against the real database: for every protected
// route, no session -> 401, session without the permission -> 403, session
// with the permission -> success. Also covers every reason a session stops
// being valid. Fixtures are created with the owner user and removed at the end.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import { generateSessionToken, hashToken, SESSION_COOKIE } from '../../src/core/auth/session-token.js';
import { loadConfig } from '../../src/core/config/index.js';
import { createPool } from '../../src/core/db/pool.js';
import { createQueue, QUEUES } from '../../src/core/queue/queues.js';
import { createRedisClient } from '../../src/core/redis/client.js';
import { multipart } from '../helpers/auth-fixtures.js';
import { docx } from '../helpers/docx.js';
import { pdf } from '../helpers/pdf.js';
import { deriveCsrfToken } from '../../src/core/security/csrf.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const PREFIX = `matrix_${randomBytes(4).toString('hex')}`;

// One entry per protected route. A new protected route without an entry here
// makes the matrix fail, so no route escapes it.
const MATRIX_CASES = {
  'GET /api/v1/permissions': { url: () => '/api/v1/permissions', success: 200 },
  'POST /api/v1/users/:id/mfa/reset': { url: (f) => `/api/v1/users/${f.targetId}/mfa/reset`, success: 200 },
  'GET /api/v1/users': { url: () => '/api/v1/users', success: 200 },
  'GET /api/v1/users/review/local': { url: () => '/api/v1/users/review/local', success: 200 },
  'GET /api/v1/users/:id': { url: (f) => `/api/v1/users/${f.targetId}`, success: 200 },
  'POST /api/v1/users': {
    url: () => '/api/v1/users', success: 201,
    payload: (f) => ({ username: `${PREFIX}.creado`, email: `${PREFIX}.creado@example.test`, displayName: 'Creado', areaId: f.areaId }),
  },
  'PATCH /api/v1/users/:id': { url: (f) => `/api/v1/users/${f.targetId}`, success: 200, payload: () => ({ displayName: 'Otro' }) },
  'POST /api/v1/users/:id/disable': { url: (f) => `/api/v1/users/${f.targetId}/disable`, success: 200 },
  'POST /api/v1/users/:id/enable': { url: (f) => `/api/v1/users/${f.targetId}/enable`, success: 200 },
  'POST /api/v1/users/:id/unlock': { url: (f) => `/api/v1/users/${f.targetId}/unlock`, success: 200 },
  'POST /api/v1/users/:id/reset-password': { url: (f) => `/api/v1/users/${f.targetId}/reset-password`, success: 200 },
  'POST /api/v1/users/:id/renew': {
    url: (f) => `/api/v1/users/${f.targetId}/renew`, success: 200,
    payload: () => ({ days: 10, reason: 'Renovación de prueba de la matriz' }),
  },
  'PUT /api/v1/users/:id/roles': { url: (f) => `/api/v1/users/${f.targetId}/roles`, success: 200, payload: () => ({ roleIds: [] }) },
  'GET /api/v1/users/:id/sessions': { url: (f) => `/api/v1/users/${f.targetId}/sessions`, success: 200 },
  'DELETE /api/v1/users/:id/sessions': { url: (f) => `/api/v1/users/${f.targetId}/sessions`, success: 200 },
  'POST /api/v1/areas': { url: () => '/api/v1/areas', success: 201, payload: () => ({ name: `${PREFIX}-nueva` }) },
  'PATCH /api/v1/areas/:id': { url: (f) => `/api/v1/areas/${f.areaId}`, success: 200, payload: () => ({ adDepartment: `${PREFIX}-dep` }) },
  'GET /api/v1/users/:id/permissions': { url: (f) => `/api/v1/users/${f.targetId}/permissions`, success: 200 },
  'GET /api/v1/roles': { url: () => '/api/v1/roles', success: 200 },
  'GET /api/v1/roles/:id': { url: (f) => `/api/v1/roles/${f.extraRoleId}`, success: 200 },
  'POST /api/v1/roles': { url: () => '/api/v1/roles', success: 201, payload: () => ({ name: `${PREFIX}-creado` }) },
  'PATCH /api/v1/roles/:id': { url: (f) => `/api/v1/roles/${f.extraRoleId}`, success: 200, payload: () => ({ description: 'Matriz' }) },
  'PUT /api/v1/roles/:id/permissions': {
    url: (f) => `/api/v1/roles/${f.extraRoleId}/permissions`, success: 200, payload: () => ({ permissions: [] }),
  },
  'DELETE /api/v1/roles/:id': { url: (f) => `/api/v1/roles/${f.deletableRoleId}`, success: 200 },
  'GET /api/v1/directory/mappings': { url: () => '/api/v1/directory/mappings', success: 200 },
  'POST /api/v1/directory/mappings': {
    url: () => '/api/v1/directory/mappings', success: 201,
    payload: (f) => ({ groupDn: `CN=${PREFIX}-matriz,DC=empresa,DC=test`, roleId: f.extraRoleId }),
  },
  'DELETE /api/v1/directory/mappings/:id': { url: (f) => `/api/v1/directory/mappings/${f.mappingId}`, success: 200 },
  'GET /api/v1/settings': { url: () => '/api/v1/settings', success: 200 },
  'PATCH /api/v1/settings/:key': {
    url: () => '/api/v1/settings/test_send.daily_max_per_user', success: 200, payload: () => ({ value: 5 }),
  },
  'GET /api/v1/senders': { url: () => '/api/v1/senders', success: 200 },
  'POST /api/v1/senders': {
    url: () => '/api/v1/senders', success: 201,
    payload: (f) => ({ areaId: f.areaId, email: `${PREFIX}.nuevo@envios.matriz.test`, displayName: 'Matriz' }),
  },
  'PATCH /api/v1/senders/:id': { url: (f) => `/api/v1/senders/${f.senderId}`, success: 200, payload: () => ({ displayName: 'Otro' }) },
  'GET /api/v1/quotas/me': { url: () => '/api/v1/quotas/me', success: 200 },
  'GET /api/v1/quotas/global': { url: () => '/api/v1/quotas/global', success: 200 },
  'GET /api/v1/quotas': { url: () => '/api/v1/quotas', success: 200 },
  'GET /api/v1/quotas/:userId/movements': { url: (f) => `/api/v1/quotas/${f.allowedId}/movements`, success: 200 },
  'POST /api/v1/quotas/:userId/adjust': {
    url: (f) => `/api/v1/quotas/${f.targetId}/adjust`, success: 200, payload: () => ({ delta: 10, reason: 'Ajuste de la matriz de autorización' }),
  },
  'GET /api/v1/lists': { url: () => '/api/v1/lists', success: 200 },
  'POST /api/v1/lists': { url: () => '/api/v1/lists', success: 201, payload: () => ({ name: `${PREFIX}-nueva`, attributes: ['ciudad'] }) },
  'GET /api/v1/lists/:id': { url: (f) => `/api/v1/lists/${f.listId}`, success: 200 },
  'PATCH /api/v1/lists/:id': { url: (f) => `/api/v1/lists/${f.listId}`, success: 200, payload: () => ({ description: 'Matriz' }) },
  'GET /api/v1/lists/:id/contacts': { url: (f) => `/api/v1/lists/${f.listId}/contacts`, success: 200 },
  'POST /api/v1/lists/:id/contacts': { url: (f) => `/api/v1/lists/${f.listId}/contacts`, success: 201, payload: () => ({ email: `${PREFIX}@matriz.test` }) },
  'PATCH /api/v1/contacts/:id': { url: (f) => `/api/v1/contacts/${f.contactId}`, success: 200, payload: () => ({ firstName: 'Otro' }) },
  'DELETE /api/v1/contacts/:id': { url: (f) => `/api/v1/contacts/${f.contactId}`, success: 200 },
  'POST /api/v1/lists/:id/imports': { url: (f) => `/api/v1/lists/${f.listId}/imports`, success: 202, multipart: () => multipart('m.csv', 'email\nm@matriz.test\n') },
  'GET /api/v1/lists/:id/imports': { url: (f) => `/api/v1/lists/${f.listId}/imports`, success: 200 },
  'GET /api/v1/imports/:id': { url: (f) => `/api/v1/imports/${f.importId}`, success: 200 },
  'GET /api/v1/lists/:id/export': { url: (f) => `/api/v1/lists/${f.listId}/export`, success: 200 },
  'GET /api/v1/suppressions': { url: () => '/api/v1/suppressions', success: 200 },
  'POST /api/v1/suppressions': { url: () => '/api/v1/suppressions', success: 201, payload: () => ({ email: `${PREFIX}.alta@matriz.test` }) },
  'DELETE /api/v1/suppressions/:id': { url: (f) => `/api/v1/suppressions/${f.suppressionId}`, success: 200 },
  'POST /api/v1/suppressions/anonymize': { url: () => '/api/v1/suppressions/anonymize', success: 200, payload: () => ({ email: `${PREFIX}.anon@matriz.test` }) },
  'GET /api/v1/templates': { url: () => '/api/v1/templates', success: 200 },
  'POST /api/v1/templates': { url: () => '/api/v1/templates', success: 201, payload: () => ({ name: `${PREFIX}-nueva` }) },
  'GET /api/v1/templates/:id': { url: (f) => `/api/v1/templates/${f.templateId}`, success: 200 },
  'PATCH /api/v1/templates/:id': { url: (f) => `/api/v1/templates/${f.templateId}`, success: 200, payload: () => ({ description: 'Matriz' }) },
  'POST /api/v1/templates/:id/versions': {
    url: (f) => `/api/v1/templates/${f.templateId}/versions`, success: 202,
    multipart: () => multipart('m.docx', docx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  },
  'GET /api/v1/templates/:id/versions/:version': { url: (f) => `/api/v1/templates/${f.templateId}/versions/1`, success: 200 },
  'GET /api/v1/templates/:id/versions/:version/preview': { url: (f) => `/api/v1/templates/${f.templateId}/versions/1/preview`, success: 200 },
  'DELETE /api/v1/templates/:id': { url: (f) => `/api/v1/templates/${f.archivableTemplateId}`, success: 200 },
  'GET /api/v1/campaigns': { url: () => '/api/v1/campaigns', success: 200 },
  'POST /api/v1/campaigns': {
    url: () => '/api/v1/campaigns', success: 201,
    payload: (f) => ({ name: 'Matriz', subject: 'Asunto', templateId: f.templateId, listId: f.listId, senderId: f.campaignSenderId }),
  },
  'GET /api/v1/campaigns/:id': { url: (f) => `/api/v1/campaigns/${f.campaigns.draft}`, success: 200 },
  'PATCH /api/v1/campaigns/:id': { url: (f) => `/api/v1/campaigns/${f.campaigns.draft}`, success: 200, payload: () => ({ name: 'Matriz editada' }) },
  'GET /api/v1/campaigns/:id/recipients': { url: (f) => `/api/v1/campaigns/${f.campaigns.draft}/recipients`, success: 200 },
  'POST /api/v1/campaigns/:id/test-send': {
    url: (f) => `/api/v1/campaigns/${f.campaigns.draft}/test-send`, success: 202, payload: () => ({ email: `${PREFIX}.allowed@example.test` }),
  },
  'POST /api/v1/campaigns/:id/attachment': {
    url: (f) => `/api/v1/campaigns/${f.campaigns.draft}/attachment`, success: 202, multipart: () => multipart('m.pdf', pdf(), 'application/pdf'),
  },
  'DELETE /api/v1/campaigns/:id/attachment': { url: (f) => `/api/v1/campaigns/${f.campaigns.withAttachment}/attachment`, success: 200 },
  'POST /api/v1/campaigns/:id/submit': { url: (f) => `/api/v1/campaigns/${f.campaigns.toSubmit}/submit`, success: 200 },
  'POST /api/v1/campaigns/:id/approve': { url: (f) => `/api/v1/campaigns/${f.campaigns.toApprove}/approve`, success: 200 },
  'POST /api/v1/campaigns/:id/reject': { url: (f) => `/api/v1/campaigns/${f.campaigns.toReject}/reject`, success: 200, payload: () => ({ reason: 'Revisar asunto' }) },
  'POST /api/v1/campaigns/:id/cancel': { url: (f) => `/api/v1/campaigns/${f.campaigns.toCancel}/cancel`, success: 200, payload: () => ({ reason: 'Ya no aplica' }) },
  'POST /api/v1/campaigns/:id/pause': { url: (f) => `/api/v1/campaigns/${f.campaigns.toPause}/pause`, success: 200 },
  'POST /api/v1/campaigns/:id/resume': { url: (f) => `/api/v1/campaigns/${f.campaigns.toResume}/resume`, success: 200 },
  'GET /api/v1/reports/campaigns': { url: () => '/api/v1/reports/campaigns', success: 200 },
  'GET /api/v1/reports/campaigns/:id': { url: (f) => `/api/v1/reports/campaigns/${f.campaigns.draft}`, success: 200 },
  'GET /api/v1/reports/campaigns/:id/recipients': { url: (f) => `/api/v1/reports/campaigns/${f.campaigns.draft}/recipients`, success: 200 },
  'GET /api/v1/reports/campaigns/:id/export': { url: (f) => `/api/v1/reports/campaigns/${f.campaigns.draft}/export`, success: 200 },
  'POST /api/v1/reports/contacts/search': { url: () => '/api/v1/reports/contacts/search', success: 200, payload: () => ({ email: `${PREFIX}.uno@matriz.test` }) },
  'DELETE /api/v1/campaigns/:id': { url: (f) => `/api/v1/campaigns/${f.campaigns.toDelete}`, success: 200 },
  'GET /api/v1/audit-logs': { url: () => '/api/v1/audit-logs?pageSize=5', success: 200 },
  'GET /api/v1/audit-logs/export': { url: () => `/api/v1/audit-logs/export?${exportRange()}`, success: 200 },
};

function exportRange() {
  const day = 24 * 60 * 60 * 1000;
  return new URLSearchParams({
    from: new Date(Date.now() - day).toISOString(), to: new Date(Date.now() + day).toISOString(),
  }).toString();
}

describe('matriz de autorización', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let app;
  let pool;
  let redis;
  let fileQueue;
  let sendQueue;
  let owner;
  let config;
  const tokens = {};

  // Users with every route permission hold administrative ones, so they need
  // MFA: the fixture marks it as configured and the session as verified.
  async function createUser(name, {
    roleId, status = 'active', deleted = false, lockedMinutes = 0, expiresInMinutes = 43200, mfa = Boolean(roleId),
  } = {}) {
    const { rows } = await owner.query(
      `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, status, deleted_at,
                          locked_until, expires_at, mfa_secret_encrypted, mfa_enabled_at)
       VALUES ($1, $2, $8, 'local', '$argon2id$v=19$m=19456,t=2,p=1$x$y', $3, $4,
               CASE WHEN $5 THEN now() END,
               CASE WHEN $6 > 0 THEN now() + make_interval(mins => $6) END,
               now() + make_interval(mins => $7),
               CASE WHEN $9 THEN '\\x00'::bytea END, CASE WHEN $9 THEN now() END)
       RETURNING id`,
      [`${PREFIX}.${name}`, `${PREFIX}.${name}@example.test`, fixtures.areaId, status, deleted, lockedMinutes,
        expiresInMinutes, `Usuario ${name}`, mfa],
    );
    if (roleId) await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [rows[0].id, roleId]);
    return rows[0].id;
  }

  async function createSession(name, userId, { revoked = false, idleMinutes = 0 } = {}) {
    const token = generateSessionToken();
    await owner.query(
      `INSERT INTO sessions (id, user_id, expires_at, revoked_at, last_seen_at, mfa_verified_at, reauth_at)
       VALUES ($1, $2, now() + interval '8 hours', CASE WHEN $3 THEN now() END, now() - make_interval(mins => $4),
               now(), now())`,
      [hashToken(token), userId, revoked, idleMinutes],
    );
    tokens[name] = token;
  }

  const fixtures = {};

  before(async () => {
    owner = new pg.Client({ connectionString: readFileSync(process.env.MIGRATION_DATABASE_URL_FILE, 'utf8').trim() });
    await owner.connect();
    config = loadConfig(process.env);
    const logger = pino({ level: 'silent' });
    pool = createPool(config.database, logger, 'enviotec-tests');
    redis = createRedisClient(config.redis, logger);
    await redis.connect();
    fileQueue = createQueue(QUEUES.files, config.redis);
    sendQueue = createQueue(QUEUES.send, config.redis);
    app = await buildApp({ config, logger, db: pool, redis, fileQueue, sendQueue, checks: { database: async () => {} } });

    const { rows: area } = await owner.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [PREFIX]);
    fixtures.areaId = area[0].id;
    const { rows: role } = await owner.query('INSERT INTO roles (name) VALUES ($1) RETURNING id', [PREFIX]);
    fixtures.roleId = role[0].id;
    const routePermissions = app.routeInventory.filter((route) => !route.public).map((route) => route.permission);
    await owner.query(
      'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2::text[])',
      [fixtures.roleId, routePermissions],
    );

    fixtures.targetId = await createUser('target', { mfa: false });
    // Roles the matrix user does not hold (nobody edits a role they hold).
    const extra = await owner.query('INSERT INTO roles (name) VALUES ($1), ($2), ($3) RETURNING id',
      [`${PREFIX}-extra`, `${PREFIX}-borrable`, `${PREFIX}-mapeado`]);
    [fixtures.extraRoleId, fixtures.deletableRoleId, fixtures.mappedRoleId] = extra.rows.map((row) => row.id);
    const mapping = await owner.query('INSERT INTO ad_group_role_mappings (group_dn, role_id) VALUES ($1, $2) RETURNING id',
      [`CN=${PREFIX}-fijo,DC=empresa,DC=test`, fixtures.mappedRoleId]);
    fixtures.mappingId = mapping.rows[0].id;
    const allowed = await createUser('allowed', { roleId: fixtures.roleId });
    fixtures.allowedId = allowed;
    const domains = await owner.query("SELECT key, value FROM system_settings WHERE key IN ('sending.sender_domains', 'sending.reply_to_domains')");
    fixtures.savedDomains = domains.rows;
    await owner.query("UPDATE system_settings SET value = '[\"envios.matriz.test\"]' WHERE key = 'sending.sender_domains'");
    const sender = await owner.query(
      'INSERT INTO sender_identities (area_id, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [fixtures.areaId, `${PREFIX}@envios.matriz.test`, 'Matriz'],
    );
    fixtures.senderId = sender.rows[0].id;
    const list = await owner.query('INSERT INTO contact_lists (area_id, name) VALUES ($1, $2) RETURNING id', [fixtures.areaId, `${PREFIX}-lista`]);
    fixtures.listId = list.rows[0].id;
    const contact = await owner.query('INSERT INTO contacts (area_id, list_id, email) VALUES ($1, $2, $3) RETURNING id',
      [fixtures.areaId, fixtures.listId, `${PREFIX}.c@matriz.test`]);
    fixtures.contactId = contact.rows[0].id;
    const imported = await owner.query(
      `INSERT INTO contact_imports (area_id, list_id, file_id, original_name, size_bytes, sha256, created_by, status)
       VALUES ($1, $2, gen_random_uuid(), 'm.csv', 10, repeat('a', 64), $3, 'failed') RETURNING id`,
      [fixtures.areaId, fixtures.listId, allowed],
    );
    fixtures.importId = imported.rows[0].id;
    const suppression = await owner.query(
      "INSERT INTO suppressions (email_hash, email, reason, source) VALUES (sha256(convert_to($1, 'UTF8')), $1, 'manual', 'manual') RETURNING id",
      [`${PREFIX}.s@matriz.test`],
    );
    fixtures.suppressionId = suppression.rows[0].id;
    const templates = await owner.query('INSERT INTO templates (area_id, name) VALUES ($1, $2), ($1, $3) RETURNING id',
      [fixtures.areaId, `${PREFIX}-plantilla`, `${PREFIX}-archivable`]);
    [fixtures.templateId, fixtures.archivableTemplateId] = templates.rows.map((row) => row.id);
    await owner.query(
      `INSERT INTO template_versions (template_id, version, status, file_id, original_name, size_bytes, sha256, html, text_body, created_by)
       VALUES ($1, 1, 'ready', gen_random_uuid(), 'm.docx', 10, repeat('a', 64), '<p>Hola</p>', 'Hola', $2)`,
      [fixtures.templateId, allowed],
    );
    // Campaign fixtures, one per state-changing route. The matrix user holds
    // every route permission, so the ones it must approve were submitted by
    // the target user (maker-checker), and quotas cover the reservations.
    await owner.query('INSERT INTO contacts (area_id, list_id, email) VALUES ($1, $2, $3)', [fixtures.areaId, fixtures.listId, `${PREFIX}.r@matriz.test`]);
    await owner.query('INSERT INTO quotas (user_id, assigned) VALUES ($1, 100), ($2, 100)', [allowed, fixtures.targetId]);
    const campaignSender = await owner.query('INSERT INTO sender_identities (area_id, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [fixtures.areaId, `${PREFIX}.c@envios.matriz.test`, 'Campañas']);
    fixtures.campaignSenderId = campaignSender.rows[0].id;
    const attachment = await owner.query(
      `INSERT INTO campaign_attachments (area_id, file_id, original_name, size_bytes, sha256, status, created_by)
       VALUES ($1, gen_random_uuid(), 'm.pdf', 10, repeat('a', 64), 'ready', $2) RETURNING id`,
      [fixtures.areaId, allowed],
    );
    const versionId = (await owner.query('SELECT id FROM template_versions WHERE template_id = $1', [fixtures.templateId])).rows[0].id;
    const campaign = async (status, extra = {}) => (await owner.query(
      `INSERT INTO campaigns (area_id, name, subject, template_version_id, list_id, sender_id, attachment_id, status, created_by,
                              submitted_by, approved_by, reserved, recipient_count)
       VALUES ($1, 'Matriz', 'Asunto', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [fixtures.areaId, versionId, fixtures.listId, fixtures.campaignSenderId, attachment.rows[0].id, status, extra.createdBy ?? allowed,
        extra.submittedBy ?? null, extra.approvedBy ?? null, extra.reserved ?? 0, extra.reserved ?? null],
    )).rows[0].id;
    fixtures.campaigns = {
      draft: await campaign('draft'),
      toSubmit: await campaign('draft'),
      toApprove: await campaign('submitted', { createdBy: fixtures.targetId, submittedBy: fixtures.targetId }),
      toReject: await campaign('submitted', { createdBy: fixtures.targetId, submittedBy: fixtures.targetId }),
      toCancel: await campaign('submitted', { createdBy: fixtures.targetId, submittedBy: fixtures.targetId }),
      toPause: await campaign('approved', { createdBy: fixtures.targetId, submittedBy: fixtures.targetId, approvedBy: allowed }),
      toResume: await campaign('paused', { createdBy: fixtures.targetId, submittedBy: fixtures.targetId, approvedBy: allowed }),
      toDelete: await campaign('draft'),
      withAttachment: await campaign('draft'),
    };
    await createSession('allowed', allowed);
    await createSession('withoutPermission', await createUser('noperm'));
    await createSession('disabled', await createUser('disabled', { roleId: fixtures.roleId, status: 'disabled' }));
    await createSession('deleted', await createUser('deleted', { roleId: fixtures.roleId, deleted: true }));
    await createSession('locked', await createUser('locked', { roleId: fixtures.roleId, lockedMinutes: 10 }));
    await createSession('accountExpired', await createUser('expired', { roleId: fixtures.roleId, expiresInMinutes: -1 }));
    await createSession('revoked', allowed, { revoked: true });
    await createSession('idle', allowed, { idleMinutes: 31 });
    const expired = generateSessionToken();
    await owner.query(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, now() - interval '9 hours', now() - interval '1 minute', now() - interval '1 hour')`,
      [hashToken(expired), allowed],
    );
    tokens.absoluteExpired = expired;
  });

  after(async () => {
    await app?.close();
    await pool?.end();
    await redis?.quit();
    await fileQueue?.close();
    await sendQueue?.close();
    if (owner) {
      // Audited users cannot be deleted (audit_logs references them with ON
      // DELETE RESTRICT): fixtures are soft-deleted and lose their access.
      await owner.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'test_cleanup'
          WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE username LIKE $1)`,
        [`${PREFIX}.%`],
      );
      await owner.query('DELETE FROM ad_group_role_mappings WHERE group_dn LIKE $1', [`CN=${PREFIX}-%`]);
      for (const row of fixtures.savedDomains ?? []) {
        await owner.query('UPDATE system_settings SET value = $2::jsonb WHERE key = $1', [row.key, JSON.stringify(row.value)]);
      }
      await owner.query('DELETE FROM user_roles WHERE role_id = $1', [fixtures.roleId]);
      await owner.query('DELETE FROM role_permissions WHERE role_id = $1', [fixtures.roleId]);
      await owner.query("UPDATE users SET deleted_at = now(), status = 'disabled' WHERE username LIKE $1", [`${PREFIX}.%`]);
      await owner.end();
    }
  });

  // State-changing requests carry what the browser would send: Origin and
  // the session's CSRF token.
  const request = (method, url, token, payload) => {
    const headers = { origin: config.security.appOrigin, ...(payload?.headers ?? {}) };
    if (payload?.headers) payload = payload.payload;
    if (token) {
      headers.cookie = `${SESSION_COOKIE}=${token}`;
      headers['x-csrf-token'] = deriveCsrfToken(config.security.csrfSecret, hashToken(token));
    }
    return app.inject({ method, url, headers, payload });
  };

  it('cada ruta protegida tiene su caso en la matriz', () => {
    const protectedRoutes = app.routeInventory.filter((route) => route.permission !== null && route.method !== 'HEAD');
    for (const route of protectedRoutes) {
      assert.ok(MATRIX_CASES[`${route.method} ${route.url}`], `falta el caso de matriz para ${route.method} ${route.url}`);
    }
  });

  for (const [route, testCase] of Object.entries(MATRIX_CASES)) {
    const [method] = route.split(' ');

    it(`${route}: sin sesión -> 401`, async () => {
      const res = await request(method, testCase.url(fixtures), undefined, (testCase.multipart ?? testCase.payload)?.(fixtures));
      assert.equal(res.statusCode, 401);
    });

    it(`${route}: sesión sin el permiso -> 403`, async () => {
      const res = await request(method, testCase.url(fixtures), tokens.withoutPermission, (testCase.multipart ?? testCase.payload)?.(fixtures));
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'FORBIDDEN');
      const { rows } = await owner.query(
        `SELECT 1 FROM audit_logs WHERE action = 'authorization.deny' AND result = 'denied'
            AND resource_id = $1 AND actor_session_id = $2`,
        [route, hashToken(tokens.withoutPermission)],
      );
      assert.ok(rows.length > 0, 'todo 403 queda auditado (A7)');
    });

    it(`${route}: sesión con el permiso -> ${testCase.success}`, async () => {
      const res = await request(method, testCase.url(fixtures), tokens.allowed, (testCase.multipart ?? testCase.payload)?.(fixtures));
      assert.equal(res.statusCode, testCase.success, res.body);
    });
  }

  it('GET /api/v1/permissions devuelve el catálogo sincronizado', async () => {
    const res = await request('GET', '/api/v1/permissions', tokens.allowed);
    const body = res.json();
    assert.equal(body.meta.total, body.data.length);
    assert.ok(body.data.some((p) => p.code === 'roles.assign' && p.administrative === true));
    assert.deepEqual(Object.keys(body.data[0]).sort(), ['administrative', 'code', 'description']);
  });

  for (const state of ['revoked', 'idle', 'absoluteExpired', 'disabled', 'deleted', 'locked', 'accountExpired']) {
    it(`una sesión inválida (${state}) responde 401`, async () => {
      const res = await request('GET', '/api/v1/permissions', tokens[state]);
      assert.equal(res.statusCode, 401);
    });
  }

  it('toda ruta con sesión (permiso o authenticated) responde 401 sin sesión', async () => {
    const routes = app.routeInventory.filter((route) => !route.public && route.method !== 'HEAD');
    for (const route of routes) {
      const url = route.url.replace(':id', route.url.includes('sessions') ? 'a'.repeat(64) : fixtures.targetId)
        .replace(':key', 'test_send.daily_max_per_user').replace(':userId', fixtures.targetId).replace(':version', '1');
      const res = await request(route.method, url);
      assert.equal(res.statusCode, 401, `${route.method} ${route.url}`);
    }
  });

  it('una sesión con MFA pendiente no usa sus permisos (AUTH_STEP_REQUIRED)', async () => {
    const pending = generateSessionToken();
    await owner.query('INSERT INTO sessions (id, user_id, expires_at) SELECT $1, id, now() + interval \'1 hour\' FROM users WHERE username = $2',
      [hashToken(pending), `${PREFIX}.allowed`]);
    const res = await request('GET', '/api/v1/permissions', pending);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'AUTH_STEP_REQUIRED');
    assert.deepEqual(res.json().error.details, [{ field: 'stage', code: 'mfa_verify' }]);
  });

  it('una sesión vencida por inactividad queda revocada y auditada', async () => {
    await request('GET', '/api/v1/permissions', tokens.idle);
    const { rows } = await owner.query(
      `SELECT s.revoked_reason, (SELECT count(*) FROM audit_logs a WHERE a.action = 'auth.session_expire' AND a.actor_session_id = s.id) AS audited
         FROM sessions s WHERE s.id = $1`,
      [hashToken(tokens.idle)],
    );
    assert.equal(rows[0].revoked_reason, 'expired');
    assert.equal(Number(rows[0].audited), 1);
  });

  it('un token desconocido con formato válido responde 401', async () => {
    const res = await request('GET', '/api/v1/permissions', generateSessionToken());
    assert.equal(res.statusCode, 401);
  });
});
