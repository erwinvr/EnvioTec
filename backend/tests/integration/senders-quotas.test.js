// Senders and quotas (Parte B, ADR-011) against the real PostgreSQL.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createAuditService } from '../../src/core/audit/audit.service.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { createQuotasRepository } from '../../src/modules/quotas/quotas.repository.js';
import { createQuotasService } from '../../src/modules/quotas/quotas.service.js';
import { createHarness } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const REASON = 'Asignación inicial aprobada por la jefatura';

describe('remitentes y cuotas', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let adminToken;
  let operator;
  let operatorToken;
  let otherArea;
  let savedSettings;
  const call = (method, url, payload, token = adminToken) => h.request(method, url, { token, payload });
  const quotas = () => createQuotasService({ db: h.pool, repository: createQuotasRepository(), audit: createAuditService() });

  before(async () => {
    h = await createHarness();
    await h.role('admin', ['senders.manage', 'quotas.view', 'quotas.manage', 'campaigns.view', 'areas.view_all']);
    await h.role('operador', ['campaigns.view', 'quotas.view']);
    const admin = await h.localUser('admin', { roles: [h.roles.admin], mfa: true });
    adminToken = await h.session(admin.id);
    operator = await h.localUser('operador', { roles: [h.roles.operador] });
    operatorToken = (await h.login(operator.username)).token;
    otherArea = await h.area('otra');
    const { rows } = await h.owner.query("SELECT key, value FROM system_settings WHERE key IN ('sending.sender_domains', 'sending.reply_to_domains')");
    savedSettings = rows;
  });
  after(async () => {
    for (const row of savedSettings ?? []) {
      await h.owner.query('UPDATE system_settings SET value = $2::jsonb WHERE key = $1', [row.key, JSON.stringify(row.value)]);
    }
    await h?.close();
  });

  const setDomains = (senders, replyTo) => h.owner.query(
    "UPDATE system_settings SET value = CASE key WHEN 'sending.sender_domains' THEN $1::jsonb ELSE $2::jsonb END WHERE key IN ('sending.sender_domains', 'sending.reply_to_domains')",
    [JSON.stringify(senders), JSON.stringify(replyTo)],
  );

  it('remitentes: sin dominios configurados no se crean; con ellos solo del subdominio de envío', async () => {
    await setDomains([], []);
    const body = { areaId: h.areaId, email: `${h.prefix}@envios.empresa.test`, displayName: 'Ventas', replyTo: `${h.prefix}@empresa.test` };
    assert.equal((await call('POST', '/api/v1/senders', body)).json().error.details[0].code, 'sender_domains_not_configured');
    await setDomains(['envios.empresa.test'], ['empresa.test']);
    const created = await call('POST', '/api/v1/senders', body);
    assert.equal(created.statusCode, 201);
    assert.equal((await call('POST', '/api/v1/senders', { ...body, email: `${h.prefix}@empresa.test` })).json().error.details[0].code, 'domain_not_allowed');
    assert.equal((await call('POST', '/api/v1/senders', { ...body, displayName: 'Ventas\r\nBcc: x@y' })).statusCode, 422);
    assert.equal((await call('POST', '/api/v1/senders', body)).statusCode, 409, 'mismo email en la misma área');
    assert.equal((await h.audits('sender.create', created.json().data.id)).length, 1);
  });

  it('remitentes: el operador ve solo los activos de su área; desactivar los oculta', async () => {
    await setDomains(['envios.empresa.test'], ['empresa.test']);
    const mine = (await call('POST', '/api/v1/senders', { areaId: h.areaId, email: `${h.prefix}.mio@envios.empresa.test`, displayName: 'Mío' })).json().data;
    const other = (await call('POST', '/api/v1/senders', { areaId: otherArea, email: `${h.prefix}.otro@envios.empresa.test`, displayName: 'Otro' })).json().data;
    let list = (await call('GET', '/api/v1/senders', undefined, operatorToken)).json().data.map((s) => s.id);
    assert.ok(list.includes(mine.id) && !list.includes(other.id));
    await call('PATCH', `/api/v1/senders/${mine.id}`, { isActive: false });
    list = (await call('GET', '/api/v1/senders', undefined, operatorToken)).json().data.map((s) => s.id);
    assert.ok(!list.includes(mine.id));
    assert.ok((await call('GET', '/api/v1/senders')).json().data.some((s) => s.id === mine.id && !s.isActive));
    assert.equal((await call('PATCH', `/api/v1/senders/${mine.id}`, { email: 'x@envios.empresa.test' })).statusCode, 422, 'el email no cambia');
  });

  it('ajuste de cuota: motivo, re-autenticación, nunca la propia, auditado con movimiento', async () => {
    const adjust = (delta, token = adminToken, userId = operator.id) => call('POST', `/api/v1/quotas/${userId}/adjust`, { delta, reason: REASON }, token);
    const res = await adjust(500);
    assert.deepEqual(res.json().data, { assigned: 500, reserved: 0, consumed: 0, available: 500 });
    const self = await h.owner.query('SELECT s.user_id FROM sessions s JOIN user_roles ur ON ur.user_id = s.user_id WHERE ur.role_id = $1 LIMIT 1', [h.roles.admin]);
    assert.equal((await adjust(10, adminToken, self.rows[0].user_id)).statusCode, 409);
    assert.equal((await call('POST', `/api/v1/quotas/${operator.id}/adjust`, { delta: 10, reason: 'corto' })).statusCode, 422);
    assert.equal((await adjust(0)).statusCode, 422);
    const noReauth = await h.session(self.rows[0].user_id, { reauth: false });
    assert.equal((await adjust(10, noReauth)).json().error.code, 'REAUTH_REQUIRED');
    assert.equal((await h.audits('quota.adjust', operator.id)).length, 1);
  });

  it('el operador ve su saldo e historial, y no el de otros', async () => {
    const mine = (await call('GET', '/api/v1/quotas/me', undefined, operatorToken)).json();
    assert.equal(mine.data.quota.assigned, 500);
    assert.equal(mine.data.movements[0].kind, 'adjust');
    assert.equal(mine.data.movements[0].reason, REASON);
    const someone = await h.localUser('ajeno');
    assert.equal((await call('GET', `/api/v1/quotas/${someone.id}/movements`, undefined, operatorToken)).statusCode, 404);
    const listed = (await call('GET', '/api/v1/quotas', undefined, operatorToken)).json().data;
    assert.deepEqual(listed.map((row) => row.userId), [operator.id]);
    assert.ok((await call('GET', `/api/v1/quotas?search=${h.prefix}`)).json().meta.total >= 2);
  });

  it('reserva, consumo y liberación respetan el saldo y el tope global con bloqueo de fila', async () => {
    const service = quotas();
    const user = await h.localUser('campania');
    await call('POST', `/api/v1/quotas/${user.id}/adjust`, { delta: 100, reason: REASON });
    await withTransaction(h.pool, (client) => service.reserve(client, { userId: user.id, amount: 60 }));
    await assert.rejects(withTransaction(h.pool, (client) => service.reserve(client, { userId: user.id, amount: 41 })), (e) => e.statusCode === 409);
    await withTransaction(h.pool, (client) => service.consume(client, { userId: user.id, amount: 50 }));
    await withTransaction(h.pool, (client) => service.release(client, { userId: user.id, amount: 10 }));
    const { rows } = await h.owner.query('SELECT assigned, reserved, consumed FROM quotas WHERE user_id = $1', [user.id]);
    assert.deepEqual(rows[0], { assigned: 100, reserved: 0, consumed: 50 });
    const kinds = (await h.owner.query('SELECT kind FROM quota_movements WHERE user_id = $1 ORDER BY occurred_at, id', [user.id])).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['adjust', 'reserve', 'consume', 'release']);
    const usage = (await call('GET', '/api/v1/quotas/global')).json().data;
    assert.ok(usage.sent >= 50 && usage.cap === 100000);
  });

  it('dos reservas simultáneas no superan el saldo (FOR UPDATE)', async () => {
    const service = quotas();
    const user = await h.localUser('concurrente');
    await call('POST', `/api/v1/quotas/${user.id}/adjust`, { delta: 100, reason: REASON });
    const results = await Promise.allSettled([1, 2, 3].map(() =>
      withTransaction(h.pool, (client) => service.reserve(client, { userId: user.id, amount: 40 }))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    const { rows } = await h.owner.query('SELECT reserved FROM quotas WHERE user_id = $1', [user.id]);
    assert.equal(rows[0].reserved, 80);
  });

  it('el tope global detiene el consumo', async () => {
    const service = quotas();
    const user = await h.localUser('tope');
    await call('POST', `/api/v1/quotas/${user.id}/adjust`, { delta: 10, reason: REASON });
    const { rows } = await h.owner.query("SELECT value FROM system_settings WHERE key = 'sending.monthly_global_cap'");
    const usage = (await call('GET', '/api/v1/quotas/global')).json().data;
    await h.owner.query("UPDATE system_settings SET value = $1::jsonb WHERE key = 'sending.monthly_global_cap'", [JSON.stringify(usage.sent + 1)]);
    try {
      await assert.rejects(withTransaction(h.pool, (client) => service.consume(client, { userId: user.id, amount: 2, fromReserve: false })),
        (e) => e.code === 'GLOBAL_CAP_REACHED');
      const { rows: q } = await h.owner.query('SELECT consumed FROM quotas WHERE user_id = $1', [user.id]);
      assert.equal(q[0].consumed, 0, 'nada se consumió');
    } finally {
      await h.owner.query("UPDATE system_settings SET value = $1::jsonb WHERE key = 'sending.monthly_global_cap'", [JSON.stringify(rows[0].value)]);
    }
  });

  it('el historial de movimientos es inmodificable, incluso para el dueño de las tablas', async () => {
    await h.owner.query('BEGIN');
    try {
      await assert.rejects(h.owner.query('UPDATE quota_movements SET amount = 1'), /append-only/);
    } finally {
      await h.owner.query('ROLLBACK');
    }
    await assert.rejects(h.pool.query('DELETE FROM quota_movements'), /permission denied|append-only/);
    await assert.rejects(h.owner.query("UPDATE quotas SET reserved = assigned + 1 WHERE user_id = $1", [operator.id]), /quotas_within_assigned/);
  });
});
