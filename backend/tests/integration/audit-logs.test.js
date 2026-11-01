// Audit query and export, emergency account alert and partition maintenance
// (A7, Parte B, R12) against the real PostgreSQL and Redis.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setImmediate } from 'node:timers';
import { pino } from 'pino';
import { ensurePartitions } from '../../src/core/db/partitions.js';
import { createHarness, PASSWORD } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const DAY = 24 * 60 * 60 * 1000;
const range = (fromDays = -1, toDays = 1) => new URLSearchParams({
  from: new Date(Date.now() + fromDays * DAY).toISOString(),
  to: new Date(Date.now() + toDays * DAY).toISOString(),
});

describe('consulta y exportación de auditoría', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let auditor;
  const mailer = { enabled: true, sent: [], async send(message) { this.sent.push(message); } };

  before(async () => {
    h = await createHarness({ env: { RATE_LIMIT_LOGIN_PER_ACCOUNT: '50' }, mailer });
    const role = await h.role('auditor', ['audit.view', 'audit.export', 'areas.view_all']);
    auditor = await h.localUser('auditor', { roles: [role] });
  });
  after(() => h?.close());

  it('lista con filtros y paginación, sin hashes ni sesiones en la respuesta', async () => {
    const target = await h.localUser('filtro');
    await h.login(target.username, 'mala-contraseña');
    const { token } = await h.login(auditor.username);
    const res = await h.request('GET', `/api/v1/audit-logs?action=auth.login&resourceId=${target.id}&result=failure&pageSize=10`, { token });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.meta.total, 1);
    assert.equal(body.meta.pageSize, 10);
    const [event] = body.data;
    assert.equal(event.action, 'auth.login');
    assert.equal(event.metadata.reason, 'invalid_password');
    assert.ok(!('hash' in event) && !('prevHash' in event) && !('actorSessionId' in event));
  });

  it('valida los parámetros: tamaño de página, rango invertido y campos desconocidos', async () => {
    const { token } = await h.login(auditor.username);
    for (const query of ['pageSize=101', 'page=0', 'result=otro', 'orderBy=ip', 'action=DROP%20TABLE',
      `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() - DAY).toISOString())}`]) {
      const res = await h.request('GET', `/api/v1/audit-logs?${query}`, { token });
      assert.equal(res.statusCode, 422, query);
    }
  });

  it('exportar exige re-autenticación', async () => {
    const { token } = await h.login(auditor.username);
    const res = await h.request('GET', `/api/v1/audit-logs/export?${range()}`, { token });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'REAUTH_REQUIRED');
  });

  it('exporta CSV con BOM, neutraliza fórmulas y queda auditada', async () => {
    await h.owner.query(
      `SELECT append_audit_log('system', NULL, NULL, 'test.injection', 'test', '=HYPERLINK("http://atacante")', 'success',
                               NULL, NULL, NULL, '{}')`,
    );
    const { token } = await h.login(auditor.username);
    await h.request('POST', '/api/v1/auth/reauth', { token, payload: { password: PASSWORD } });
    const res = await h.request('GET', `/api/v1/audit-logs/export?${range()}&action=test.injection`, { token });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/csv; charset=utf-8/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="auditoria-\d{8}-\d{8}\.csv"$/);
    assert.ok(res.body.startsWith('﻿"fecha_utc"'));
    assert.ok(res.body.includes(`"'=HYPERLINK(""http://atacante"")"`));
    assert.ok(!res.body.includes(',"=HYPERLINK'));

    const { rows } = await h.owner.query(
      "SELECT metadata FROM audit_logs WHERE action = 'audit.export' AND actor_user_id = $1 ORDER BY seq DESC LIMIT 1",
      [auditor.id],
    );
    assert.equal(rows[0].metadata.filters.action, 'test.injection');
    assert.ok(rows[0].metadata.rows >= 1);
  });

  it('exportar exige rango de fechas de hasta 92 días', async () => {
    const { token } = await h.login(auditor.username);
    await h.request('POST', '/api/v1/auth/reauth', { token, payload: { password: PASSWORD } });
    assert.equal((await h.request('GET', '/api/v1/audit-logs/export', { token })).statusCode, 422);
    const res = await h.request('GET', `/api/v1/audit-logs/export?${range(-100, 0)}`, { token });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.details[0].code, 'range_too_long');
  });

  it('la cuenta de emergencia: evento destacado y alerta por correo a los administradores', async () => {
    const emergency = await h.localUser('emergencia');
    await h.owner.query('UPDATE users SET is_emergency = true WHERE id = $1', [emergency.id]);
    const { rows: setting } = await h.owner.query("SELECT value FROM system_settings WHERE key = 'notifications.admin_emails'");
    await h.owner.query("UPDATE system_settings SET value = '[\"seguridad@empresa.test\", \"ti@empresa.test\"]' WHERE key = 'notifications.admin_emails'");
    try {
      mailer.sent.length = 0;
      const { res } = await h.login(emergency.username);
      assert.equal(res.statusCode, 200);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(mailer.sent.map((m) => m.to).sort(), ['seguridad@empresa.test', 'ti@empresa.test']);
      assert.ok(mailer.sent.every((m) => m.tag === 'emergency-login' && m.text.includes(emergency.username)));
      const events = await h.audits('auth.emergency_login', emergency.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].metadata.highlighted, true);
    } finally {
      await h.owner.query("UPDATE system_settings SET value = $1 WHERE key = 'notifications.admin_emails'", [JSON.stringify(setting[0].value)]);
    }
  });

  it('el worker mantiene 12 meses de particiones por delante', async () => {
    const report = await ensurePartitions(h.pool, pino({ level: 'silent' }));
    assert.equal(report.audit_logs.ok, true);
    const { rows } = await h.owner.query(
      `SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_logs'::regclass`,
    );
    assert.ok(rows[0].n >= 13);
    const again = await ensurePartitions(h.pool, pino({ level: 'silent' }));
    assert.equal(again.audit_logs.created, 0, 'repetir no crea nada');
  });
});
