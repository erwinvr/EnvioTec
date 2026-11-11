// Sending and synchronization against a Mandrill double (ADR-024) with the
// real database: batches, suppression applied again after approval, quota
// consumed only for what Mandrill accepted, definite errors put back,
// unknown outcomes reconciled without sending twice, global cap pause, test
// sends and idempotent event sync feeding the suppression list.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAuditService } from '../../src/core/audit/audit.service.js';
import { createFileStore } from '../../src/core/files/storage.js';
import { createMandrill } from '../../src/core/mail/mandrill.js';
import { createQuotasRepository } from '../../src/modules/quotas/quotas.repository.js';
import { GlobalCapReachedError } from '../../src/modules/quotas/quotas.rules.js';
import { createQuotasService } from '../../src/modules/quotas/quotas.service.js';
import { createSender } from '../../src/modules/sending/sender.service.js';
import { createSendingRepository } from '../../src/modules/sending/sending.repository.js';
import { createSync, eventKey } from '../../src/modules/sending/sync.service.js';
import { createSuppressionsRepository } from '../../src/modules/suppressions/suppressions.repository.js';
import { createHarness } from '../helpers/auth-fixtures.js';
import { startMandrillMock } from '../helpers/mandrill-mock.js';
import { pdf } from '../helpers/pdf.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe('envío y sincronización', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let mock;
  let dir;
  let operator;
  let approver;
  let refs;
  const audit = createAuditService();
  const repository = createSendingRepository();
  const queued = [];
  const mails = [];
  const silent = { warn() {}, error() {}, info() {} };

  function senderWith({ quotas, timeoutMs } = {}) {
    return createSender({
      pool: h.pool, repository, quotas: quotas ?? createQuotasService({ db: h.pool, repository: createQuotasRepository(), audit }),
      mandrill: createMandrill(mock.config, { timeoutMs }), store: createFileStore(dir), audit,
      sendQueue: { add: async (name, data) => queued.push(data) }, mailer: { send: async (m) => mails.push(m) }, logger: silent, batchSize: 2,
    });
  }

  const email = (name) => `${h.prefix}.${name}@destino.test`;
  const quota = async () => (await h.owner.query('SELECT reserved, consumed FROM quotas WHERE user_id = $1', [operator.id])).rows[0];
  const recipients = async (id) => Object.fromEntries((await h.owner.query(
    'SELECT email::text, status, message_id FROM campaign_recipients WHERE campaign_id = $1', [id],
  )).rows.map((r) => [r.email.slice(h.prefix.length + 1).split('@')[0], r]));
  const batches = async (id) => (await h.owner.query('SELECT id, status, attempts FROM send_batches WHERE campaign_id = $1 ORDER BY id', [id])).rows;
  const campaignStatus = async (id) => (await h.owner.query('SELECT status, reserved FROM campaigns WHERE id = $1', [id])).rows[0];

  // An approved campaign as approval leaves it (8.4): recipients snapshot
  // and the quota reserved.
  async function approvedCampaign(people, { withPdf = true } = {}) {
    const { rows } = await h.owner.query(
      `INSERT INTO campaigns (area_id, name, status, subject, template_version_id, list_id, sender_id, attachment_id, created_by,
                              submitted_by, submitted_at, approved_by, approved_at, recipient_count, reserved)
       VALUES ($1, 'Campaña', 'approved', 'Novedades', $2, $3, $4, $5, $6, $6, now(), $7, now(), $8, $8) RETURNING id`,
      [h.areaId, refs.versionId, refs.listId, refs.senderId, withPdf ? refs.attachmentId : null, operator.id, approver.id, people.length],
    );
    for (const [name, firstName] of people) {
      await h.owner.query('INSERT INTO campaign_recipients (campaign_id, email, first_name) VALUES ($1, $2, $3)', [rows[0].id, email(name), firstName]);
    }
    await h.owner.query('UPDATE quotas SET reserved = reserved + $2 WHERE user_id = $1', [operator.id, people.length]);
    return rows[0].id;
  }

  async function started(sender, id) {
    queued.length = 0;
    await sender.dispatch();
    assert.equal((await campaignStatus(id)).status, 'sending');
    return (await batches(id)).map((b) => b.id);
  }

  before(async () => {
    h = await createHarness();
    mock = await startMandrillMock();
    dir = await mkdtemp(join(tmpdir(), 'enviotec-sending-'));
    await mkdir(join(dir, 'stored'));
    operator = await h.localUser('operador', { mfa: true });
    approver = await h.localUser('aprobador', { mfa: true });
    await h.owner.query('INSERT INTO quotas (user_id, assigned) VALUES ($1, 100)', [operator.id]);
    const fileId = randomUUID();
    await writeFile(join(dir, 'stored', fileId), pdf());
    const { rows: template } = await h.owner.query('INSERT INTO templates (area_id, name) VALUES ($1, $2) RETURNING id', [h.areaId, `${h.prefix}-t`]);
    const { rows: version } = await h.owner.query(
      `INSERT INTO template_versions (template_id, version, status, file_id, original_name, size_bytes, sha256, html, text_body, variables, created_by)
       VALUES ($1, 1, 'ready', gen_random_uuid(), 'p.docx', 10, repeat('a', 64), '<p>Hola {{first_name}}</p>', 'Hola {{first_name}}', '{first_name}', $2) RETURNING id`,
      [template[0].id, operator.id],
    );
    const { rows: list } = await h.owner.query('INSERT INTO contact_lists (area_id, name) VALUES ($1, $2) RETURNING id', [h.areaId, `${h.prefix}-l`]);
    const { rows: sender } = await h.owner.query(
      'INSERT INTO sender_identities (area_id, email, display_name, reply_to) VALUES ($1, $2, $3, $4) RETURNING id',
      [h.areaId, `${h.prefix}@envios.test`, 'Ventas', 'ventas@empresa.test'],
    );
    const { rows: attachment } = await h.owner.query(
      `INSERT INTO campaign_attachments (area_id, file_id, original_name, size_bytes, sha256, status, created_by)
       VALUES ($1, $2, 'folleto.pdf', 100, repeat('b', 64), 'ready', $3) RETURNING id`,
      [h.areaId, fileId, operator.id],
    );
    refs = { versionId: version[0].id, listId: list[0].id, senderId: sender[0].id, attachmentId: attachment[0].id };
  });
  after(async () => {
    await mock?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    await h?.close();
  });

  it('lotes: supresión aplicada otra vez, rechazados devueltos, cuota consumida solo por lo aceptado y liberación al terminar', async () => {
    mock.state.mode = 'ok';
    mock.state.reject.add(email('rechazado'));
    const before = await quota();
    const id = await approvedCampaign([['ana', '<b>Ana</b>'], ['rechazado', 'R'], ['suprimido', 'S'], ['dora', 'Dora']]);
    // Suppressed after approval: still excluded (Parte B: no exceptions).
    await h.owner.query("INSERT INTO suppressions (email_hash, email, reason, source) VALUES (sha256(convert_to($1, 'UTF8')), $1, 'unsubscribe', 'manual')", [email('suprimido')]);
    const sender = senderWith();
    const ids = await started(sender, id);
    assert.equal(ids.length, 2);
    assert.deepEqual(queued.filter((job) => ids.includes(job.batchId)).length, 2);

    for (const batchId of ids) await sender.sendBatch(batchId);
    const sentTo = mock.state.sent.flatMap((m) => m.to.map((t) => t.email));
    assert.ok(!sentTo.includes(email('suprimido')));
    const first = mock.state.sent.find((m) => m.metadata.campaign_id === id);
    assert.equal(first.preserve_recipients, false);
    assert.equal(first.html, '<p>Hola {{{first_name}}}</p>');
    assert.equal(first.merge_vars[0].vars[0].content, '&lt;b&gt;Ana&lt;/b&gt;', 'el escape lo hace EnvioTec');
    assert.equal(first.attachments[0].name, 'folleto.pdf');

    const r = await recipients(id);
    assert.deepEqual([r.ana.status, r.rechazado.status, r.suprimido.status, r.dora.status], ['sent', 'rejected', 'suppressed', 'sent']);
    assert.ok(r.ana.message_id);
    const during = await quota();
    assert.equal(during.consumed - before.consumed, 2, 'solo lo aceptado consume');

    await sender.dispatch();
    assert.deepEqual(await campaignStatus(id), { status: 'completed', reserved: 0 });
    const done = await quota();
    assert.deepEqual([done.reserved - before.reserved, done.consumed - before.consumed], [0, 2]);
    assert.equal((await h.audits('campaign.start', id)).length, 1);
    assert.equal((await h.audits('campaign.complete', id))[0].metadata.released, 2);
    const refund = await h.owner.query("SELECT amount FROM quota_movements WHERE campaign_id = $1 AND kind = 'refund'", [id]);
    assert.deepEqual(refund.rows.map((row) => row.amount), [1]);
  });

  it('error definitivo de Mandrill: el lote vuelve a pendiente con la cuota devuelta y se reintenta', async () => {
    const id = await approvedCampaign([['eva', 'Eva']]);
    const sender = senderWith();
    const [batchId] = await started(sender, id);
    const before = await quota();
    mock.state.mode = 'error';
    assert.deepEqual(await sender.sendBatch(batchId), { putBack: 500 });
    assert.deepEqual((await batches(id))[0], { id: batchId, status: 'pending', attempts: 1 });
    assert.deepEqual(await quota(), before);
    assert.equal((await recipients(id)).eva.status, 'pending');
    queued.length = 0;
    await sender.dispatch();
    assert.ok(!queued.some((job) => job.batchId === batchId), 'backoff: no se vuelve a encolar enseguida');
    mock.state.mode = 'ok';
    assert.deepEqual(await sender.sendBatch(batchId), { accepted: 1, rejected: 0 });
  });

  it('resultado incierto: el lote queda ambiguo y la conciliación lo cierra sin enviar dos veces', async () => {
    const id = await approvedCampaign([['fabi', 'Fabi'], ['gabo', 'Gabo']]);
    const sender = senderWith({ timeoutMs: 300 });
    const [batchId] = await started(sender, id);
    mock.state.mode = 'hang';
    assert.deepEqual(await sender.sendBatch(batchId), { ambiguous: true });
    mock.state.mode = 'ok';
    assert.equal((await batches(id))[0].status, 'ambiguous');
    assert.deepEqual(await sender.sendBatch(batchId), { skipped: 'not_sendable' }, 'nunca se reintenta a ciegas');
    const calls = mock.state.sent.length;

    // Old enough to reconcile (the trigger would refresh updated_at).
    await h.owner.query('BEGIN');
    await h.owner.query('ALTER TABLE send_batches DISABLE TRIGGER send_batches_updated_at');
    await h.owner.query("UPDATE send_batches SET updated_at = now() - interval '61 minutes' WHERE id = $1", [batchId]);
    await h.owner.query('ALTER TABLE send_batches ENABLE TRIGGER send_batches_updated_at');
    await h.owner.query('COMMIT');
    // By email and batch_id, without the metadata index (ADR-029).
    mock.state.indexed = false;
    try {
      await sender.reconcile();
    } finally {
      mock.state.indexed = true;
    }
    assert.equal(mock.state.sent.length, calls, 'la conciliación no envía');
    assert.equal((await batches(id))[0].status, 'accepted');
    const r = await recipients(id);
    assert.deepEqual([r.fabi.status, r.gabo.status], ['sent', 'sent']);
    assert.equal((await h.audits('campaign.batch_reconcile', batchId))[0].metadata.found, 2);
  });

  it('tope global alcanzado: la campaña se pausa, se audita y se avisa a los administradores', async () => {
    const id = await approvedCampaign([['hugo', 'Hugo']]);
    const real = createQuotasService({ db: h.pool, repository: createQuotasRepository(), audit });
    const sender = senderWith({ quotas: { ...real, consume: async () => { throw new GlobalCapReachedError(); } } });
    const [batchId] = await started(sender, id);
    await h.owner.query("UPDATE system_settings SET value = $1 WHERE key = 'notifications.admin_emails'", [JSON.stringify(['admin@empresa.test'])]);
    try {
      mails.length = 0;
      assert.deepEqual(await sender.sendBatch(batchId), { paused: 'global_cap' });
    } finally {
      await h.owner.query("UPDATE system_settings SET value = '[]' WHERE key = 'notifications.admin_emails'");
    }
    assert.equal((await campaignStatus(id)).status, 'paused');
    assert.equal((await batches(id))[0].status, 'pending');
    assert.equal((await h.audits('campaign.pause', id))[0].metadata.reason, 'global_cap');
    assert.deepEqual(mails.map((m) => [m.to, m.tag]), [['admin@empresa.test', 'global-cap']]);
  });

  it('sin PDF (opcional, ADR-027): el lote sale sin adjunto', async () => {
    mock.state.mode = 'ok';
    const id = await approvedCampaign([['nora', 'Nora']], { withPdf: false });
    const sender = senderWith();
    const [batchId] = await started(sender, id);
    assert.deepEqual(await sender.sendBatch(batchId), { accepted: 1, rejected: 0 });
    const message = mock.state.sent.find((m) => m.metadata.batch_id === batchId);
    assert.deepEqual(message.attachments, []);
  });

  it('según fecha del contacto: cada ciclo envía solo a quienes ya les toca y la campaña termina con el último (ADR-030)', async () => {
    mock.state.mode = 'ok';
    const id = await approvedCampaign([['hoy', 'Hoy'], ['manana', 'Mañana']]);
    await h.owner.query("UPDATE campaign_recipients SET send_at = now() - interval '1 minute' WHERE campaign_id = $1 AND email = $2", [id, email('hoy')]);
    await h.owner.query("UPDATE campaign_recipients SET send_at = now() + interval '1 day' WHERE campaign_id = $1 AND email = $2", [id, email('manana')]);
    const sender = senderWith();
    const first = await started(sender, id);
    assert.equal(first.length, 1, 'solo el lote de hoy');
    await sender.sendBatch(first[0]);
    await sender.dispatch();
    assert.equal((await campaignStatus(id)).status, 'sending', 'no termina mientras queda alguien por fecha');
    assert.equal((await recipients(id)).manana.status, 'pending');

    await h.owner.query("UPDATE campaign_recipients SET send_at = now() - interval '1 minute' WHERE campaign_id = $1 AND email = $2", [id, email('manana')]);
    queued.length = 0;
    await sender.dispatch();
    const second = (await batches(id)).filter((b) => b.status === 'pending');
    assert.equal(second.length, 1, 'el lote de mañana se arma cuando llega su fecha');
    await sender.sendBatch(second[0].id);
    await sender.dispatch();
    assert.deepEqual(await campaignStatus(id), { status: 'completed', reserved: 0 });
    const r = await recipients(id);
    assert.deepEqual([r.hoy.status, r.manana.status], ['sent', 'sent']);
  });

  it('campaña cancelada: sus lotes pendientes no se envían', async () => {
    const id = await approvedCampaign([['ines', 'Ines']]);
    const sender = senderWith();
    const [batchId] = await started(sender, id);
    await h.owner.query("UPDATE campaigns SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [id]);
    const calls = mock.state.sent.length;
    await sender.sendBatch(batchId);
    assert.equal(mock.state.sent.length, calls);
    assert.equal((await batches(id))[0].status, 'cancelled');
    assert.equal((await recipients(id)).ines.status, 'cancelled');
  });

  it('envío de prueba: variables como [nombre] y asunto marcado; sin clave se rechaza con motivo', async () => {
    const id = await approvedCampaign([['juan', 'Juan']]);
    const insert = async () => (await h.owner.query(
      'INSERT INTO campaign_test_sends (campaign_id, user_id, email) VALUES ($1, $2, $3) RETURNING id', [id, operator.id, operator.email],
    )).rows[0].id;
    const sender = senderWith();
    const testId = await insert();
    await sender.testSend(testId);
    const message = mock.state.sent.at(-1);
    assert.equal(message.subject, '[PRUEBA] Novedades');
    assert.equal(message.merge_vars[0].vars[0].content, '[first_name]');
    const { rows } = await h.owner.query('SELECT status, message_id FROM campaign_test_sends WHERE id = $1', [testId]);
    assert.equal(rows[0].status, 'sent');
    assert.ok(rows[0].message_id);
    assert.equal((await h.audits('campaign.test_delivery', id))[0].result, 'success');

    const unconfigured = await insert();
    await sender.rejectTestSend(unconfigured, 'sending_not_configured');
    const { rows: rejected } = await h.owner.query('SELECT status, error FROM campaign_test_sends WHERE id = $1', [unconfigured]);
    assert.deepEqual(rejected[0], { status: 'failed', error: 'sending_not_configured' });
  });

  it('anonimización: la copia en la campaña pierde sus datos personales y el pendiente no se envía', async () => {
    const id = await approvedCampaign([['olga', 'Olga'], ['pepe', 'Pepe']]);
    const sender = senderWith();
    const [batchId] = await started(sender, id);
    await createSuppressionsRepository().anonymize(h.pool, email('olga'));
    const { rows } = await h.owner.query(
      "SELECT first_name, status FROM campaign_recipients WHERE campaign_id = $1 AND email::text LIKE 'anon-%@anonimizado.invalid'", [id],
    );
    assert.deepEqual(rows, [{ first_name: null, status: 'suppressed' }]);
    await sender.sendBatch(batchId);
    const sentTo = mock.state.sent.filter((m) => m.metadata.batch_id === batchId).flatMap((m) => m.to.map((t) => t.email));
    assert.deepEqual(sentTo, [email('pepe')]);
  });

  it('sincronización: eventos guardados una sola vez; rebotes, quejas y bajas pasan a supresión global', async () => {
    const id = await approvedCampaign([['kati', 'Kati'], ['luis', 'Luis']]);
    const sender = senderWith();
    for (const batchId of await started(sender, id)) await sender.sendBatch(batchId);
    const now = Math.floor(Date.now() / 1000);
    for (const message of mock.state.messages.filter((m) => m.metadata.campaign_id === id)) {
      if (message.email === email('kati')) Object.assign(message, { opens_detail: [{ ts: now }], clicks_detail: [{ ts: now, url: 'https://empresa.test/x' }] });
      else message.state = 'bounced';
    }
    mock.state.rejects.push({ email: email('queja'), reason: 'spam' });
    const sync = createSync({ pool: h.pool, repository, mandrill: createMandrill(mock.config), audit, logger: silent });
    await sync.run();
    await sync.run();
    // At the search limit the campaign is searched batch by batch: same events, none twice.
    const searches = mock.state.requests.length;
    await createSync({ pool: h.pool, repository, mandrill: createMandrill(mock.config), audit, logger: silent, searchLimit: 1 }).run();
    assert.ok(mock.state.requests.slice(searches).some((r) => r.body.query?.startsWith('u_batch_id:')));

    const { rows: events } = await h.owner.query('SELECT event_type, count(*)::int AS n FROM message_events WHERE campaign_id = $1 GROUP BY 1 ORDER BY 1', [id]);
    assert.deepEqual(events, [{ event_type: 'click', n: 1 }, { event_type: 'hard_bounce', n: 1 }, { event_type: 'open', n: 1 }, { event_type: 'sent', n: 1 }]);
    const { rows: suppressed } = await h.owner.query(
      "SELECT email::text, reason FROM suppressions WHERE email = ANY($1::text[]) AND source = 'mandrill' ORDER BY reason",
      [[email('luis'), email('queja')]],
    );
    assert.deepEqual(suppressed, [{ email: email('queja'), reason: 'complaint' }, { email: email('luis'), reason: 'hard_bounce' }]);
  });

  it('sin metadata indexada: la sincronización lee por id y guarda el detalle de cada apertura (ADR-029)', async () => {
    const id = await approvedCampaign([['mara', 'Mara']]);
    const sender = senderWith();
    for (const batchId of await started(sender, id)) await sender.sendBatch(batchId);
    const now = Math.floor(Date.now() / 1000);
    const message = mock.state.messages.find((m) => m.metadata.campaign_id === id);
    message.opens_detail = [
      { ts: now, ip: '74.125.10.1', location: 'California, US', ua: null },
      { ts: now + 60, ip: '200.87.1.2', location: 'La Paz, BO', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
    ];
    // An event stored before ADR-029, without details, is completed.
    const recipient = (await h.owner.query('SELECT id FROM campaign_recipients WHERE campaign_id = $1', [id])).rows[0].id;
    await h.owner.query(
      `INSERT INTO message_events (campaign_id, recipient_id, message_id, event_type, occurred_at, idempotency_key)
       VALUES ($1, $2, $3, 'open', to_timestamp($4), $5)`,
      [id, recipient, message._id, now, eventKey(message._id, 'open', now)],
    );
    mock.state.indexed = false;
    try {
      const summary = await createSync({ pool: h.pool, repository, mandrill: createMandrill(mock.config), audit, logger: silent, infoPerRun: 1000 }).run();
      assert.ok(summary.byId >= 1, JSON.stringify(summary));
    } finally {
      mock.state.indexed = true;
    }
    const { rows } = await h.owner.query(
      `SELECT event_type, host(ip) AS ip, location, device, os, client FROM message_events
        WHERE campaign_id = $1 AND event_type = 'open' ORDER BY occurred_at`, [id],
    );
    assert.deepEqual(rows, [
      { event_type: 'open', ip: '74.125.10.1', location: 'California, US', device: 'proxy', os: null, client: 'Gmail (proxy de imágenes)' },
      { event_type: 'open', ip: '200.87.1.2', location: 'La Paz, BO', device: 'mobile', os: 'iOS', client: 'Apple Mail / Safari' },
    ]);
    assert.equal((await h.owner.query("SELECT count(*)::int AS n FROM message_events WHERE campaign_id = $1 AND event_type = 'sent'", [id])).rows[0].n, 1);
  });
});
