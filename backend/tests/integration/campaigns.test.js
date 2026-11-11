// Campaign workflow end to end (Parte B, ADR-011): PDF inspected in the
// file-processor (ClamAV + qpdf), submit, maker-checker approval with the
// recipients snapshot (suppression applied) and quota reservation, edit back
// to draft, cancellation, test sends and area scope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { createQueue, QUEUES } from '../../src/core/queue/queues.js';
import { createHarness, multipart } from '../helpers/auth-fixtures.js';
import { pdf } from '../helpers/pdf.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe('campañas', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let fileQueue;
  let sendQueue;
  let operator;
  let operatorToken;
  let approverToken;
  let refs;
  let otherArea;
  const as = (token) => (method, url, payload) => h.request(method, url, { token, payload });
  const op = (...args) => as(operatorToken)(...args);
  const ap = (...args) => as(approverToken)(...args);

  async function fixtures(areaId, { variables = ['first_name'], attributes = [], types = {} } = {}) {
    const { rows: template } = await h.owner.query('INSERT INTO templates (area_id, name) VALUES ($1, $2) RETURNING id', [areaId, `${h.prefix}-t-${Math.random()}`]);
    await h.owner.query(
      `INSERT INTO template_versions (template_id, version, status, file_id, original_name, size_bytes, sha256, html, text_body, variables, created_by)
       VALUES ($1, 1, 'ready', gen_random_uuid(), 'p.docx', 10, repeat('a', 64), '<p>Hola {{first_name}}</p>', 'Hola', $2, $3)`,
      [template[0].id, variables, operator.id],
    );
    const { rows: list } = await h.owner.query('INSERT INTO contact_lists (area_id, name, attributes, attribute_types) VALUES ($1, $2, $3, $4) RETURNING id',
      [areaId, `${h.prefix}-l-${Math.random()}`, attributes, types]);
    for (const email of ['uno@destino.test', 'dos@destino.test', `${h.prefix}.suprimido@destino.test`]) {
      await h.owner.query('INSERT INTO contacts (area_id, list_id, email, first_name) VALUES ($1, $2, $3, $4)', [areaId, list[0].id, email, 'X']);
    }
    const { rows: sender } = await h.owner.query('INSERT INTO sender_identities (area_id, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [areaId, `${h.prefix}.${Math.random().toString(36).slice(2)}@envios.test`, 'Ventas']);
    return { templateId: template[0].id, listId: list[0].id, senderId: sender[0].id };
  }

  async function readyCampaign(extra = {}) {
    const created = await op('POST', '/api/v1/campaigns', { name: 'Campaña de prueba', subject: 'Novedades', ...refs, ...extra });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.id;
    const upload = await h.request('POST', `/api/v1/campaigns/${id}/attachment`, { token: operatorToken, ...multipart('folleto.pdf', pdf(), 'application/pdf') });
    assert.equal(upload.statusCode, 202, upload.body);
    for (let i = 0; i < 120; i += 1) {
      const status = (await op('GET', `/api/v1/campaigns/${id}`)).json().data.attachment.status;
      if (status !== 'pending') {
        assert.equal(status, 'ready');
        return id;
      }
      await sleep(500);
    }
    throw new Error('attachment still pending');
  }

  const quota = async (userId) => (await h.owner.query('SELECT assigned, reserved, consumed FROM quotas WHERE user_id = $1', [userId])).rows[0];

  before(async () => {
    const url = { url: readFileSync(process.env.REDIS_URL_FILE, 'utf8').trim() };
    fileQueue = createQueue(QUEUES.files, url);
    sendQueue = createQueue(QUEUES.send, url);
    h = await createHarness({ fileQueue, sendQueue });
    await h.role('operador', ['campaigns.view', 'campaigns.create', 'campaigns.update', 'campaigns.delete', 'campaigns.submit',
      'campaigns.cancel', 'campaigns.pause', 'campaigns.send_test', 'campaigns.approve']);
    await h.role('aprobador', ['campaigns.view', 'campaigns.approve']);
    operator = await h.localUser('operador', { roles: [h.roles.operador], mfa: true });
    operatorToken = await h.session(operator.id);
    const approver = await h.localUser('aprobador', { roles: [h.roles.aprobador], mfa: true });
    approverToken = await h.session(approver.id);
    await h.owner.query('INSERT INTO quotas (user_id, assigned) VALUES ($1, 100)', [operator.id]);
    refs = await fixtures(h.areaId);
    await h.owner.query("INSERT INTO suppressions (email_hash, email, reason, source) VALUES (sha256(convert_to($1, 'UTF8')), $1, 'hard_bounce', 'mandrill')",
      [`${h.prefix}.suprimido@destino.test`]);
    otherArea = await h.area('otra');
  });
  after(async () => {
    await fileQueue?.close();
    await sendQueue?.close();
    await h?.close();
  });

  it('referencias de otra área se rechazan; la campaña de otra área no se ve', async () => {
    const foreign = await fixtures(otherArea);
    const res = await op('POST', '/api/v1/campaigns', { name: 'Ajena', subject: 'Asunto', templateId: foreign.templateId, listId: refs.listId, senderId: refs.senderId });
    assert.equal(res.json().error.details[0].code, 'invalid_template');
    assert.equal((await op('POST', '/api/v1/campaigns', { name: 'Inyección', subject: 'Asunto\r\nBcc: a@b.c', ...refs })).statusCode, 422);
    const { rows } = await h.owner.query(
      `INSERT INTO campaigns (area_id, name, subject, template_version_id, list_id, sender_id, created_by)
       SELECT $1, 'Ajena', 'S', tv.id, $3, $4, $5 FROM template_versions tv WHERE tv.template_id = $2 RETURNING id`,
      [otherArea, foreign.templateId, foreign.listId, foreign.senderId, operator.id],
    );
    assert.equal((await op('GET', `/api/v1/campaigns/${rows[0].id}`)).statusCode, 404);
  });

  it('PDF del adjunto inspeccionado: con JavaScript se rechaza', async () => {
    const id = (await op('POST', '/api/v1/campaigns', { name: 'JS', subject: 'S', ...refs })).json().data.id;
    await h.request('POST', `/api/v1/campaigns/${id}/attachment`, {
      token: operatorToken, ...multipart('malo.pdf', pdf({ extra: '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' }), 'application/pdf'),
    });
    let attachment;
    for (let i = 0; i < 120; i += 1) {
      attachment = (await op('GET', `/api/v1/campaigns/${id}`)).json().data.attachment;
      if (attachment.status !== 'pending') break;
      await sleep(500);
    }
    assert.deepEqual([attachment.status, attachment.failureReason], ['failed', 'active_content']);
    assert.equal((await op('POST', `/api/v1/campaigns/${id}/submit`)).json().error.details[0].code, 'attachment_not_ready');
    // The PDF is optional (ADR-027): once the rejected one is removed, the campaign goes without it.
    const removed = await op('DELETE', `/api/v1/campaigns/${id}/attachment`);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().data.attachment, null);
    assert.equal((await h.audits('campaign.attachment_remove', id)).length, 1);
    assert.equal((await op('DELETE', `/api/v1/campaigns/${id}/attachment`)).json().error.details[0].code, 'no_attachment');
    const submitted = await op('POST', `/api/v1/campaigns/${id}/submit`);
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.equal((await op('DELETE', `/api/v1/campaigns/${id}/attachment`)).statusCode, 409, 'solo en borrador');
  });

  it('flujo completo: enviar a aprobación, maker-checker, foto sin suprimidos y reserva de cuota', async () => {
    const id = await readyCampaign();
    assert.equal((await op('POST', `/api/v1/campaigns/${id}/submit`)).json().data.status, 'submitted');
    const self = await op('POST', `/api/v1/campaigns/${id}/approve`);
    assert.equal(self.statusCode, 409, 'quien la envió no la aprueba');
    const approved = await ap('POST', `/api/v1/campaigns/${id}/approve`);
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().data.status, 'approved');
    assert.equal(approved.json().data.recipientCount, 2, 'el suprimido queda fuera');
    assert.deepEqual(await quota(operator.id), { assigned: 100, reserved: 2, consumed: 0 });
    const recipients = (await op('GET', `/api/v1/campaigns/${id}/recipients`)).json().data.map((r) => r.email);
    assert.ok(!recipients.some((email) => email.includes('suprimido')));
    assert.equal((await h.audits('campaign.approve', id)).length, 1);

    // Editing an approved campaign sends it back to draft and releases the reservation.
    const edited = await op('PATCH', `/api/v1/campaigns/${id}`, { subject: 'Novedades de noviembre' });
    assert.equal(edited.json().data.status, 'draft');
    assert.deepEqual(await quota(operator.id), { assigned: 100, reserved: 0, consumed: 0 });
    assert.equal((await op('GET', `/api/v1/campaigns/${id}/recipients`)).json().meta.total, 0);
  });

  it('un borrador toma la última versión lista de su plantilla al enviarse a aprobación', async () => {
    const own = await fixtures(h.areaId);
    const id = await readyCampaign(own);
    assert.equal((await op('GET', `/api/v1/campaigns/${id}`)).json().data.template.version, 1);
    await h.owner.query(
      `INSERT INTO template_versions (template_id, version, status, file_id, original_name, size_bytes, sha256, html, text_body, variables, created_by)
       VALUES ($1, 2, 'ready', gen_random_uuid(), 'p2.docx', 10, repeat('b', 64), '<p>Hola v2 {{first_name}}</p>', 'Hola v2', '{first_name}', $2)`,
      [own.templateId, operator.id],
    );
    const submitted = await op('POST', `/api/v1/campaigns/${id}/submit`);
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.equal(submitted.json().data.template.version, 2);
    assert.equal((await h.audits('campaign.submit', id))[0].metadata.versionUpdated, true);
  });

  it('una plantilla archivada impide enviar a aprobación el borrador que ya la usaba', async () => {
    const id = await readyCampaign();
    await h.owner.query('UPDATE templates SET is_archived = true WHERE id = $1', [refs.templateId]);
    try {
      const res = await op('POST', `/api/v1/campaigns/${id}/submit`);
      assert.equal(res.statusCode, 422, res.body);
      assert.ok(res.json().error.details.some((d) => d.code === 'template_archived'));
    } finally {
      await h.owner.query('UPDATE templates SET is_archived = false WHERE id = $1', [refs.templateId]);
    }
  });

  it('envío según fecha del contacto: foto con hora por destinatario y excluidos informados (ADR-030)', async () => {
    const own = await fixtures(h.areaId, { attributes: ['vence'], types: { vence: 'date' } });
    const laPaz = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date(Date.now() + days * 86400000));
    const setDate = (email, date) => h.owner.query("UPDATE contacts SET attributes = jsonb_build_object('vence', $2::text) WHERE list_id = $1 AND email = $3", [own.listId, date, email]);
    await setDate('uno@destino.test', laPaz(1));
    for (const [email, date] of [['pasado@destino.test', laPaz(-2)], ['lejos@destino.test', laPaz(400)]]) {
      await h.owner.query("INSERT INTO contacts (area_id, list_id, email, attributes) VALUES ($1, $2, $3, jsonb_build_object('vence', $4::text))", [h.areaId, own.listId, email, date]);
    }
    const bad = await op('POST', '/api/v1/campaigns', { name: 'Mala', subject: 'S', ...own, scheduleByDate: { variable: 'nope' } });
    assert.equal(bad.json().error.details[0].code, 'invalid_schedule_variable');
    const both = await op('POST', '/api/v1/campaigns', {
      name: 'Doble', subject: 'S', ...own, scheduleByDate: { variable: 'vence' }, scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(both.json().error.details[0].code, 'schedule_conflict');

    const id = await readyCampaign({ ...own, scheduleByDate: { variable: 'vence', offsetDays: 0, time: '09:00' } });
    assert.deepEqual((await op('GET', `/api/v1/campaigns/${id}`)).json().data.scheduleByDate, { variable: 'vence', offsetDays: 0, time: '09:00' });
    const before = await quota(operator.id);
    assert.equal((await op('POST', `/api/v1/campaigns/${id}/submit`)).statusCode, 200);
    const approved = await ap('POST', `/api/v1/campaigns/${id}/approve`);
    assert.equal(approved.statusCode, 200, approved.body);
    const data = approved.json().data;
    assert.deepEqual([data.status, data.recipientCount, data.excluded], ['scheduled', 1, { noDate: 1, past: 1, tooFar: 1 }]);
    assert.equal(data.scheduledAt, new Date(`${laPaz(1)}T09:00:00-04:00`).toISOString(), 'primer envío: mañana 09:00 de Bolivia');
    assert.equal((await quota(operator.id)).reserved - before.reserved, 1, 'solo se reserva lo que entra en la ventana');
    // The operator has no contacts.view: the email comes masked; the scheduled moment is what matters.
    const recipients = (await op('GET', `/api/v1/campaigns/${id}/recipients`)).json().data;
    assert.deepEqual(recipients.map((r) => r.sendAt), [data.scheduledAt]);
    // Cancelling a by-date campaign releases what it reserved.
    const cancelled = await op('POST', `/api/v1/campaigns/${id}/cancel`, { reason: 'Prueba de envío por fecha' });
    assert.equal(cancelled.json().data.status, 'cancelled');
    assert.equal((await quota(operator.id)).reserved, before.reserved);
  });

  it('la base de datos también impide que la misma persona envíe y apruebe', async () => {
    const id = await readyCampaign();
    await assert.rejects(h.owner.query(
      "UPDATE campaigns SET status = 'approved', submitted_by = $2, approved_by = $2 WHERE id = $1", [id, operator.id],
    ), /campaigns_maker_checker/);
  });

  it('sin saldo suficiente no se aprueba; cancelar libera lo reservado; rechazar vuelve a borrador', async () => {
    const id = await readyCampaign();
    await op('POST', `/api/v1/campaigns/${id}/submit`);
    await h.owner.query('UPDATE quotas SET assigned = reserved + consumed + 1 WHERE user_id = $1', [operator.id]);
    assert.equal((await ap('POST', `/api/v1/campaigns/${id}/approve`)).statusCode, 409);
    assert.equal((await op('GET', `/api/v1/campaigns/${id}/recipients`)).json().meta.total, 0, 'sin foto si no se aprobó');
    await h.owner.query('UPDATE quotas SET assigned = 100 WHERE user_id = $1', [operator.id]);
    await ap('POST', `/api/v1/campaigns/${id}/approve`);
    const cancelled = await op('POST', `/api/v1/campaigns/${id}/cancel`, { reason: 'Cambio de prioridades' });
    assert.equal(cancelled.json().data.status, 'cancelled');
    assert.equal((await quota(operator.id)).reserved, 0);

    const other = await readyCampaign();
    await op('POST', `/api/v1/campaigns/${other}/submit`);
    const rejected = await ap('POST', `/api/v1/campaigns/${other}/reject`, { reason: 'Falta revisar el asunto' });
    assert.deepEqual([rejected.json().data.status, rejected.json().data.rejectionReason], ['draft', 'Falta revisar el asunto']);
  });

  it('variables de la plantilla que la lista no tiene impiden enviar a aprobación', async () => {
    const custom = await fixtures(h.areaId, { variables: ['first_name', 'plan'] });
    const id = await readyCampaign({ templateId: custom.templateId });
    const res = await op('POST', `/api/v1/campaigns/${id}/submit`);
    assert.equal(res.json().error.details[0].code, 'missing_variable');
  });

  it('envío de prueba: solo al propio correo o dominios internos, 5 por día, descuenta saldo', async () => {
    const id = await readyCampaign();
    const before = await quota(operator.id);
    assert.equal((await op('POST', `/api/v1/campaigns/${id}/test-send`, { email: 'alguien@gmail.com' })).json().error.details[0].code, 'test_recipient_not_allowed');
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await op('POST', `/api/v1/campaigns/${id}/test-send`, { email: operator.email })).statusCode);
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 409]);
    assert.equal((await quota(operator.id)).consumed, before.consumed + 5);
  });

  it('pausa y reanudación; solo se borran borradores', async () => {
    const id = await readyCampaign();
    await op('POST', `/api/v1/campaigns/${id}/submit`);
    await ap('POST', `/api/v1/campaigns/${id}/approve`);
    assert.equal((await op('POST', `/api/v1/campaigns/${id}/pause`)).json().data.status, 'paused');
    assert.equal((await op('POST', `/api/v1/campaigns/${id}/resume`)).json().data.status, 'approved');
    assert.equal((await op('DELETE', `/api/v1/campaigns/${id}`)).statusCode, 409);
    const draft = (await op('POST', '/api/v1/campaigns', { name: 'Borrable', subject: 'S', ...refs })).json().data.id;
    assert.equal((await op('DELETE', `/api/v1/campaigns/${draft}`)).statusCode, 200);
  });
});
