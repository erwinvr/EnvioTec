// areas.view_all only widens reading (ADR-026): an operator or approver who
// also holds a reporting role reads every area but creates, changes and
// approves only in their own. A change attempted on another area's record
// is a 403, audited; pause and cancel stay available because they only stop
// sending. Without areas.view_all, other areas stay invisible (404).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHarness } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe('alcance de escritura por área', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let otherArea;
  let foreign;
  let operatorReports;
  let approverReports;
  let operatorOnly;
  const as = (token) => (method, url, payload) => h.request(method, url, { token, payload });

  // Template, list with a contact, sender and a submitted campaign in another area.
  async function seedForeignArea(ownerId) {
    const { rows: template } = await h.owner.query('INSERT INTO templates (area_id, name) VALUES ($1, $2) RETURNING id', [otherArea, `${h.prefix}-ajena`]);
    const { rows: version } = await h.owner.query(
      `INSERT INTO template_versions (template_id, version, status, file_id, original_name, size_bytes, sha256, html, text_body, variables, created_by)
       VALUES ($1, 1, 'ready', gen_random_uuid(), 'p.docx', 10, repeat('a', 64), '<p>x</p>', 'x', '{}', $2) RETURNING id`, [template[0].id, ownerId],
    );
    const { rows: list } = await h.owner.query('INSERT INTO contact_lists (area_id, name) VALUES ($1, $2) RETURNING id', [otherArea, `${h.prefix}-lista-ajena`]);
    const { rows: contact } = await h.owner.query(
      "INSERT INTO contacts (area_id, list_id, email, first_name) VALUES ($1, $2, $3, 'X') RETURNING id", [otherArea, list[0].id, `${h.prefix}.c@ajena.test`],
    );
    const { rows: sender } = await h.owner.query('INSERT INTO sender_identities (area_id, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [otherArea, `${h.prefix}@envios.test`, 'Ajena']);
    const { rows: campaign } = await h.owner.query(
      `INSERT INTO campaigns (area_id, name, status, subject, template_version_id, list_id, sender_id, created_by, submitted_by, submitted_at)
       VALUES ($1, 'Campaña ajena', 'submitted', 'Asunto', $2, $3, $4, $5, $5, now()) RETURNING id`,
      [otherArea, version[0].id, list[0].id, sender[0].id, ownerId],
    );
    return { templateId: template[0].id, listId: list[0].id, contactId: contact[0].id, campaignId: campaign[0].id, senderId: sender[0].id };
  }

  before(async () => {
    h = await createHarness();
    const operatorPermissions = ['templates.view', 'templates.create', 'templates.update', 'templates.delete', 'contacts.view', 'contacts.create',
      'contacts.update', 'contacts.delete', 'contacts.import', 'campaigns.view', 'campaigns.create', 'campaigns.update', 'campaigns.submit'];
    const reporting = ['reports.view', 'reports.export', 'campaigns.view', 'areas.view_all'];
    await h.role('operador-reportes', [...operatorPermissions, ...reporting]);
    await h.role('aprobador-reportes', ['campaigns.view', 'campaigns.approve', 'campaigns.cancel', 'campaigns.pause', ...reporting]);
    await h.role('operador', operatorPermissions);
    operatorReports = await h.session((await h.localUser('opr', { roles: [h.roles['operador-reportes']], mfa: true })).id);
    approverReports = await h.session((await h.localUser('apr', { roles: [h.roles['aprobador-reportes']], mfa: true })).id);
    operatorOnly = await h.session((await h.localUser('op', { roles: [h.roles.operador], mfa: true })).id);
    otherArea = await h.area('ajena');
    foreign = await seedForeignArea((await h.localUser('duenio', { area: otherArea })).id);
  });
  after(async () => h?.close());

  it('con areas.view_all lee la otra área, pero crea solo en la propia', async () => {
    const op = as(operatorReports);
    assert.equal((await op('GET', `/api/v1/templates/${foreign.templateId}`)).statusCode, 200);
    assert.equal((await op('GET', `/api/v1/reports/campaigns?pageSize=5`)).statusCode, 200);
    const elsewhere = await op('POST', '/api/v1/templates', { name: 'En otra área', areaId: otherArea });
    assert.equal(elsewhere.json().error.details[0].code, 'invalid_area');
    const own = await op('POST', '/api/v1/templates', { name: 'En la propia' });
    assert.equal(own.statusCode, 201, own.body);
    assert.equal(own.json().data.areaId, h.areaId);
    assert.equal((await op('POST', '/api/v1/lists', { name: 'Lista ajena', areaId: otherArea })).json().error.details[0].code, 'invalid_area');
    const campaign = await op('POST', '/api/v1/campaigns', { name: 'Ajena', subject: 'S', templateId: foreign.templateId, listId: foreign.listId, senderId: foreign.senderId });
    assert.equal(campaign.json().error.details[0].code, 'invalid_list');
  });

  it('cambiar datos de otra área responde 403 y queda auditado', async () => {
    const op = as(operatorReports);
    const attempts = [
      ['PATCH', `/api/v1/templates/${foreign.templateId}`, { name: 'Cambiada' }],
      ['DELETE', `/api/v1/templates/${foreign.templateId}`],
      ['PATCH', `/api/v1/lists/${foreign.listId}`, { name: 'Cambiada' }],
      ['POST', `/api/v1/lists/${foreign.listId}/contacts`, { email: `${h.prefix}.nuevo@ajena.test` }],
      ['PATCH', `/api/v1/contacts/${foreign.contactId}`, { firstName: 'Y' }],
      ['DELETE', `/api/v1/contacts/${foreign.contactId}`],
      ['PATCH', `/api/v1/campaigns/${foreign.campaignId}`, { name: 'Cambiada' }],
      ['POST', `/api/v1/campaigns/${foreign.campaignId}/submit`],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await op(method, url, payload);
      assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
      assert.equal(res.json().error.code, 'AREA_WRITE_DENIED');
    }
    const { rows } = await h.owner.query('SELECT name FROM templates WHERE id = $1', [foreign.templateId]);
    assert.equal(rows[0].name, `${h.prefix}-ajena`, 'nada cambió');
    const denied = await h.audits('authorization.area_deny', foreign.templateId);
    assert.deepEqual(denied.map((a) => a.result), ['denied', 'denied']);
  });

  it('un aprobador con reportes no aprueba fuera de su área, pero puede detener (cancelar)', async () => {
    const ap = as(approverReports);
    const approve = await ap('POST', `/api/v1/campaigns/${foreign.campaignId}/approve`);
    assert.equal(approve.statusCode, 403, approve.body);
    assert.equal((await ap('POST', `/api/v1/campaigns/${foreign.campaignId}/reject`, { reason: 'No corresponde' })).statusCode, 403);
    const cancel = await ap('POST', `/api/v1/campaigns/${foreign.campaignId}/cancel`, { reason: 'Detener por abuso' });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(cancel.json().data.status, 'cancelled');
  });

  it('sin areas.view_all la otra área ni se ve: 404', async () => {
    const op = as(operatorOnly);
    assert.equal((await op('GET', `/api/v1/templates/${foreign.templateId}`)).statusCode, 404);
    assert.equal((await op('PATCH', `/api/v1/templates/${foreign.templateId}`, { name: 'Cambiada' })).statusCode, 404);
    assert.equal((await op('PATCH', `/api/v1/contacts/${foreign.contactId}`, { firstName: 'Y' })).statusCode, 404);
  });
});
