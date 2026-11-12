// Reports by campaign and by contact (Parte B, ADR-025): figures from the
// send status and the tracking events, area scope (IDOR), emails masked
// without contacts.view, CSV injection neutralized, exports and lookups
// audited without the address.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createHarness } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe('reportes', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let campaignId;
  let reporter;
  let viewer;
  let foreign;
  let global;
  const email = (name) => `${h.prefix}.${name}@destino.test`;
  const get = (token, url) => h.request('GET', url, { token });

  async function seedCampaign(areaId, userId) {
    const { rows: template } = await h.owner.query('INSERT INTO templates (area_id, name) VALUES ($1, $2) RETURNING id', [areaId, `${h.prefix}-t-${Math.random()}`]);
    const { rows: version } = await h.owner.query(
      `INSERT INTO template_versions (template_id, version, status, file_id, original_name, size_bytes, sha256, html, text_body, variables, created_by)
       VALUES ($1, 1, 'ready', gen_random_uuid(), 'p.docx', 10, repeat('a', 64), '<p>x</p>', 'x', '{}', $2) RETURNING id`, [template[0].id, userId],
    );
    const { rows: list } = await h.owner.query('INSERT INTO contact_lists (area_id, name) VALUES ($1, $2) RETURNING id', [areaId, `${h.prefix}-l-${Math.random()}`]);
    const { rows: sender } = await h.owner.query('INSERT INTO sender_identities (area_id, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [areaId, `${h.prefix}.${Math.random().toString(36).slice(2)}@envios.test`, 'Ventas']);
    const { rows } = await h.owner.query(
      `INSERT INTO campaigns (area_id, name, status, subject, template_version_id, list_id, sender_id, created_by, started_at, finished_at, recipient_count)
       VALUES ($1, $2, 'completed', 'Novedades', $3, $4, $5, $6, now(), now(), 5) RETURNING id`,
      [areaId, `${h.prefix} Reporte`, version[0].id, list[0].id, sender[0].id, userId],
    );
    return rows[0].id;
  }

  async function recipient(id, name, status, events = []) {
    const { rows } = await h.owner.query(
      `INSERT INTO campaign_recipients (campaign_id, email, status, message_id, sent_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'sent' THEN md5(random()::text) END, CASE WHEN $3 = 'sent' THEN now() END) RETURNING id, message_id`,
      [id, name.includes('@') ? name : email(name), status],
    );
    for (const type of events) {
      await h.owner.query(
        `INSERT INTO message_events (campaign_id, recipient_id, message_id, event_type, occurred_at, url, idempotency_key)
         VALUES ($1, $2, $3, $4, now(), CASE WHEN $4 = 'click' THEN 'https://empresa.test' END, sha256(random()::text::bytea))`,
        [id, rows[0].id, rows[0].message_id, type],
      );
    }
  }

  before(async () => {
    h = await createHarness();
    await h.role('reportes', ['reports.view', 'reports.export']);
    await h.role('reportes-contactos', ['reports.view', 'reports.export', 'contacts.view']);
    await h.role('reportes-global', ['reports.view', 'areas.view_all']);
    const owner = await h.localUser('duenio');
    reporter = await h.session((await h.localUser('reportes', { roles: [h.roles.reportes] })).id);
    viewer = await h.session((await h.localUser('contactos', { roles: [h.roles['reportes-contactos']] })).id);
    const otherArea = await h.area('otra');
    foreign = await h.session((await h.localUser('ajeno', { roles: [h.roles.reportes], area: otherArea })).id);
    global = await h.session((await h.localUser('global', { roles: [h.roles['reportes-global']], area: otherArea })).id);
    campaignId = await seedCampaign(h.areaId, owner.id);
    await recipient(campaignId, 'ana', 'sent', ['sent', 'open', 'open', 'click']);
    await recipient(campaignId, 'beto', 'sent', ['sent', 'hard_bounce']);
    await recipient(campaignId, 'carla', 'rejected');
    await recipient(campaignId, 'dani', 'suppressed');
    await recipient(campaignId, `=HYPERLINK("x")${h.prefix}@destino.test`, 'sent', ['sent', 'spam', 'unsubscribe']);
  });
  after(async () => h?.close());

  it('cifras de la campaña: entregados sin rebotes, aperturas y clics por destinatario', async () => {
    const res = await get(reporter, `/api/v1/reports/campaigns/${campaignId}`);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data.stats, {
      recipients: 5, accepted: 3, rejected: 1, suppressed: 1, pending: 0, notSent: 0, delivered: 2, opened: 1, clicked: 1,
      hardBounces: 1, softBounces: 0, complaints: 1, unsubscribes: 1,
    });
    const list = await get(reporter, `/api/v1/reports/campaigns?search=${encodeURIComponent(`${h.prefix} Reporte`)}`);
    assert.deepEqual(list.json().data.map((c) => [c.id, c.stats.delivered]), [[campaignId, 2]]);
  });

  it('destinatarios: filtros por allowlist y correos enmascarados sin contacts.view', async () => {
    const opened = await get(reporter, `/api/v1/reports/campaigns/${campaignId}/recipients?event=opened`);
    assert.equal(opened.json().meta.total, 1);
    const [ana] = opened.json().data;
    assert.deepEqual([ana.opens, ana.clicks, ana.delivered], [2, 1, true]);
    assert.ok(!ana.email.includes(h.prefix), 'enmascarado');
    const clear = await get(viewer, `/api/v1/reports/campaigns/${campaignId}/recipients?status=rejected`);
    assert.deepEqual(clear.json().data.map((r) => r.email), [email('carla')]);
    assert.equal((await get(reporter, `/api/v1/reports/campaigns/${campaignId}/recipients?event=${encodeURIComponent("x' OR 1=1")}`)).statusCode, 422);
  });

  it('alcance por área: otra área responde 404 y no lista la campaña; areas.view_all la ve', async () => {
    assert.equal((await get(foreign, `/api/v1/reports/campaigns/${campaignId}`)).statusCode, 404);
    assert.equal((await get(foreign, `/api/v1/reports/campaigns/${campaignId}/recipients`)).statusCode, 404);
    assert.equal((await get(foreign, `/api/v1/reports/campaigns/${campaignId}/export`)).statusCode, 404);
    assert.ok(!(await get(foreign, '/api/v1/reports/campaigns?pageSize=100')).json().data.some((c) => c.id === campaignId));
    assert.equal((await get(global, `/api/v1/reports/campaigns/${campaignId}`)).statusCode, 200);
  });

  it('por contacto: la dirección va en el body, se audita solo su hash y respeta el área', async () => {
    const search = (token) => h.request('POST', '/api/v1/reports/contacts/search', { token, payload: { email: email('ana').toUpperCase() } });
    const res = await search(viewer);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data.map((r) => [r.campaignId, r.email, r.opens]), [[campaignId, email('ana'), 2]]);
    assert.equal((await search(foreign)).json().meta.total, 0);
    const hash = createHash('sha256').update(email('ana')).digest('hex');
    const audits = await h.audits('reports.contact_lookup', hash);
    assert.ok(audits.length >= 2);
    assert.ok(!JSON.stringify(audits).includes(email('ana')));
  });

  it('detalle de eventos del destinatario: IP y ubicación solo con contacts.view (ADR-029)', async () => {
    const { rows } = await h.owner.query('SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND email = $2', [campaignId, email('ana')]);
    const recipientId = rows[0].id;
    await h.owner.query(
      `UPDATE message_events SET ip = '200.87.1.2', location = 'La Paz, BO', user_agent = 'Mozilla/5.0 (iPhone)', device = 'mobile', os = 'iOS'
        WHERE recipient_id = $1 AND event_type = 'open'`, [recipientId],
    );
    const url = `/api/v1/reports/campaigns/${campaignId}/recipients/${recipientId}/events`;
    const full = (await get(viewer, url)).json().data.filter((e) => e.type === 'open');
    assert.deepEqual([full.length, full[0].ip, full[0].location, full[0].device, full[0].os], [2, '200.87.1.2', 'La Paz, BO', 'mobile', 'iOS']);
    const masked = (await get(reporter, url)).json().data.find((e) => e.type === 'open');
    assert.deepEqual([masked.ip, masked.location, masked.userAgent, masked.device], [null, null, null, 'mobile']);
    assert.equal((await get(foreign, url)).statusCode, 404);
  });

  it('resumen del período (ADR-031): cifras, serie diaria y dispositivos, solo del área', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date());
    const url = `/api/v1/reports/overview?from=${today}&to=${today}`;
    await h.owner.query(
      `UPDATE message_events SET device = 'mobile'
        WHERE event_type = 'open' AND recipient_id = (SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND email = $2)`,
      [campaignId, email('ana')],
    );
    const res = await get(reporter, url);
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json().data;
    assert.equal(data.campaigns, 1);
    assert.deepEqual([data.stats.accepted, data.stats.delivered, data.stats.opened, data.stats.clicked, data.stats.unsubscribes], [3, 2, 1, 1, 1]);
    assert.deepEqual(data.daily, [{ day: today, sent: 3, opened: 1, clicked: 1 }]);
    assert.deepEqual(data.devices, [{ device: 'mobile', recipients: 1 }]);

    const other = (await get(foreign, url)).json().data;
    assert.deepEqual([other.campaigns, other.stats.recipients, other.devices], [0, 0, []]);
    assert.ok((await get(global, url)).json().data.campaigns >= 1, 'areas.view_all ve todas las áreas');
  });

  it('resumen del período: fechas obligatorias, desde antes que hasta y como máximo un año', async () => {
    assert.equal((await get(reporter, '/api/v1/reports/overview')).statusCode, 422);
    assert.equal((await get(reporter, '/api/v1/reports/overview?from=2026-02-01&to=2026-01-01')).statusCode, 422);
    assert.equal((await get(reporter, '/api/v1/reports/overview?from=2025-01-01&to=2026-06-01')).statusCode, 422);
    assert.equal((await get(reporter, '/api/v1/reports/overview?from=2026-01-01&to=2026-12-31')).statusCode, 200);
    assert.equal((await get(reporter, "/api/v1/reports/overview?from=2026-01-01'--&to=2026-01-02")).statusCode, 422);
    assert.equal((await h.request('GET', '/api/v1/reports/overview?from=2026-01-01&to=2026-01-02', {})).statusCode, 401);
  });

  it('exportación: CSV con fórmulas neutralizadas, enmascarado según permiso y auditado', async () => {
    const clear = await get(viewer, `/api/v1/reports/campaigns/${campaignId}/export`);
    assert.equal(clear.statusCode, 200);
    assert.match(clear.headers['content-type'], /text\/csv/);
    const lines = clear.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(lines[0], '"email","status","sent_at","delivered","opens","clicks","hard_bounce","soft_bounce","complaint","unsubscribed","last_event_at","error"');
    assert.equal(lines.length, 6);
    assert.ok(lines.some((line) => line.startsWith(`"'=HYPERLINK(""x"")${h.prefix}`)), 'fórmula neutralizada');
    const masked = await get(reporter, `/api/v1/reports/campaigns/${campaignId}/export`);
    assert.ok(!masked.body.includes(h.prefix));
    const audits = await h.audits('reports.export', campaignId);
    assert.deepEqual(audits.map((a) => a.metadata.masked), [false, true]);
  });
});
