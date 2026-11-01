// Contact lists, contacts, CSV import through the isolated pipeline
// (backend -> file-processor with ClamAV -> worker), suppression and
// anonymization (Parte B, ADR-004) against the real stack.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { createQueue, QUEUES } from '../../src/core/queue/queues.js';
import { createHarness, multipart } from '../helpers/auth-fixtures.js';

const enabled = process.env.RUN_INTEGRATION === '1';
// The standard antivirus test string (not malware). ClamAV only reports it
// when the file starts with it, as the EICAR standard requires.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

describe('contactos, importación y supresión', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let fileQueue;
  let operator;
  let viewerToken;
  let adminToken;
  let otherArea;
  const call = (method, url, payload, token = operator) => h.request(method, url, { token, payload });

  async function waitImport(id, token = operator) {
    for (let i = 0; i < 120; i += 1) {
      const res = await call('GET', `/api/v1/imports/${id}`, undefined, token);
      if (res.json().data.status !== 'pending') return res.json().data;
      await sleep(500);
    }
    throw new Error('import still pending');
  }

  before(async () => {
    fileQueue = createQueue(QUEUES.files, { url: readFileSync(process.env.REDIS_URL_FILE, 'utf8').trim() });
    h = await createHarness({ fileQueue });
    await h.role('operador', ['contacts.view', 'contacts.create', 'contacts.update', 'contacts.delete', 'contacts.import', 'contacts.export', 'suppressions.view']);
    await h.role('lector', ['suppressions.view']);
    await h.role('admin', ['suppressions.view', 'suppressions.manage', 'contacts.view', 'areas.view_all']);
    operator = (await h.login((await h.localUser('operador', { roles: [h.roles.operador] })).username)).token;
    viewerToken = (await h.login((await h.localUser('lector', { roles: [h.roles.lector] })).username)).token;
    const admin = await h.localUser('admin', { roles: [h.roles.admin], mfa: true });
    adminToken = await h.session(admin.id);
    otherArea = await h.area('otra');
  });
  after(async () => {
    await fileQueue?.close();
    await h?.close();
  });

  it('listas con atributos validados; otra área no se ve (IDOR)', async () => {
    const created = await call('POST', '/api/v1/lists', { name: 'Clientes', attributes: ['ciudad', 'plan'] });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.areaId, h.areaId);
    assert.equal((await call('POST', '/api/v1/lists', { name: 'Mala', attributes: ['Email'] })).statusCode, 422);
    const reserved = await call('POST', '/api/v1/lists', { name: 'Mala', attributes: ['email'] });
    assert.equal(reserved.json().error.details[0].code, 'reserved_attribute', 'nombre reservado');
    assert.equal((await call('POST', '/api/v1/lists', { name: 'Ajena', areaId: otherArea })).json().error.details[0].code, 'invalid_area');
    const { rows } = await h.owner.query('INSERT INTO contact_lists (area_id, name) VALUES ($1, $2) RETURNING id', [otherArea, `${h.prefix}-ajena`]);
    assert.equal((await call('GET', `/api/v1/lists/${rows[0].id}`)).statusCode, 404);
    assert.equal((await call('GET', `/api/v1/lists/${rows[0].id}/contacts`)).statusCode, 404);
    assert.ok(!(await call('GET', '/api/v1/lists')).json().data.some((l) => l.id === rows[0].id));
  });

  it('contactos: alta, deduplicación por email, edición, borrado y atributos de la lista', async () => {
    const list = (await call('POST', '/api/v1/lists', { name: 'Manual', attributes: ['ciudad'] })).json().data;
    const res = await call('POST', `/api/v1/lists/${list.id}/contacts`, { email: 'Ana@Empresa.test', firstName: 'Ana', attributes: { ciudad: 'La Paz' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().data.email, 'ana@empresa.test');
    assert.equal((await call('POST', `/api/v1/lists/${list.id}/contacts`, { email: 'ANA@empresa.test' })).statusCode, 409);
    assert.equal((await call('POST', `/api/v1/lists/${list.id}/contacts`, { email: 'b@empresa.test', attributes: { rol: 'x' } })).statusCode, 422);
    const id = res.json().data.id;
    assert.equal((await call('PATCH', `/api/v1/contacts/${id}`, { lastName: 'Pérez' })).json().data.lastName, 'Pérez');
    const audit = await h.audits('contact.update', id);
    assert.ok(!JSON.stringify(audit).includes('Pérez'), 'la auditoría no guarda datos personales');
    assert.equal((await call('DELETE', `/api/v1/contacts/${id}`)).statusCode, 200);
  });

  it('importación CSV de punta a punta: antivirus, validación por fila, deduplicación y upsert', async () => {
    const list = (await call('POST', '/api/v1/lists', { name: 'Importada', attributes: ['ciudad'] })).json().data;
    await call('POST', `/api/v1/lists/${list.id}/contacts`, { email: 'existente@empresa.test', firstName: 'Viejo' });
    const csv = 'email;first_name;ciudad\nexistente@empresa.test;Nuevo;Sucre\nnuevo@empresa.test;Nuevo;La Paz\nmalo;X;Y\nNUEVO@empresa.test;Dup;Z\n';
    const body = multipart('contactos.csv', csv);
    const res = await h.request('POST', `/api/v1/lists/${list.id}/imports`, { token: operator, ...body });
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().data.status, 'pending');
    const done = await waitImport(res.json().data.id);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.deepEqual([done.totalRows, done.inserted, done.updated, done.rejected], [4, 1, 1, 2]);
    const contacts = (await call('GET', `/api/v1/lists/${list.id}/contacts`)).json().data;
    assert.equal(contacts.find((c) => c.email === 'existente@empresa.test').firstName, 'Nuevo');
    assert.equal((await h.audits('contacts.import', done.id))[0].result, 'success');
  });

  it('importación: malware rechazado por ClamAV, columnas desconocidas y archivo no CSV', async () => {
    const list = (await call('POST', '/api/v1/lists', { name: 'Riesgo' })).json().data;
    const infected = await h.request('POST', `/api/v1/lists/${list.id}/imports`, { token: operator, ...multipart('virus.csv', EICAR) });
    const failed = await waitImport(infected.json().data.id);
    assert.deepEqual([failed.status, failed.failureReason], ['failed', 'malware']);
    const unknown = await h.request('POST', `/api/v1/lists/${list.id}/imports`, { token: operator, ...multipart('x.csv', 'email,clave\na@b.test,1\n') });
    assert.equal((await waitImport(unknown.json().data.id)).failureReason, 'unknown_columns');
    const pdf = await h.request('POST', `/api/v1/lists/${list.id}/imports`, { token: operator, ...multipart('x.pdf', '%PDF-1.4', 'application/pdf') });
    assert.equal(pdf.json().error.details[0].code, 'not_csv');
    const big = await h.request('POST', `/api/v1/lists/${list.id}/imports`, { token: operator, ...multipart('big.csv', Buffer.alloc(10 * 1024 * 1024 + 10, 'a')) });
    assert.equal(big.statusCode, 413);
  });

  it('exportación con fórmulas neutralizadas y auditada', async () => {
    const list = (await call('POST', '/api/v1/lists', { name: 'Exportable', attributes: ['nota'] })).json().data;
    await call('POST', `/api/v1/lists/${list.id}/contacts`, { email: 'x@empresa.test', firstName: '=HYPERLINK("http://atacante")', attributes: { nota: '+1' } });
    const res = await call('GET', `/api/v1/lists/${list.id}/export`);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes(`"'=HYPERLINK(""http://atacante"")"`));
    assert.ok(res.body.includes(`"'+1"`));
    assert.equal((await h.audits('contacts.export', list.id)).length, 1);
  });

  it('supresión global: alta manual, emails enmascarados sin contacts.view, y solo se quitan las manuales', async () => {
    const email = `${h.prefix}.baja@empresa.test`;
    const added = await call('POST', '/api/v1/suppressions', { email }, adminToken);
    assert.equal(added.statusCode, 201);
    assert.equal((await call('POST', '/api/v1/suppressions', { email: email.toUpperCase() }, adminToken)).statusCode, 409);
    const masked = (await call('GET', `/api/v1/suppressions?search=${encodeURIComponent(email)}`, undefined, viewerToken)).json().data[0];
    assert.notEqual(masked.email, email);
    assert.match(masked.email, /\*/);
    const plain = (await call('GET', `/api/v1/suppressions?search=${encodeURIComponent(email)}`, undefined, adminToken)).json().data[0];
    assert.equal(plain.email, email);
    const { rows } = await h.owner.query(
      "INSERT INTO suppressions (email_hash, email, reason, source) VALUES (sha256(convert_to($1, 'UTF8')), $1, 'hard_bounce', 'mandrill') RETURNING id",
      [`${h.prefix}.rebote@empresa.test`],
    );
    assert.equal((await call('DELETE', `/api/v1/suppressions/${rows[0].id}`, undefined, adminToken)).statusCode, 409);
    await assert.rejects(h.owner.query('DELETE FROM suppressions WHERE id = $1', [rows[0].id]), /only manual/);
    assert.equal((await call('DELETE', `/api/v1/suppressions/${added.json().data.id}`, undefined, adminToken)).statusCode, 200);
  });

  it('anonimización a pedido: borra los datos personales en todas las áreas y deja el hash en supresión', async () => {
    const email = `${h.prefix}.olvido@empresa.test`;
    const list = (await call('POST', '/api/v1/lists', { name: 'Olvido', attributes: ['ciudad'] })).json().data;
    const contact = (await call('POST', `/api/v1/lists/${list.id}/contacts`, { email, firstName: 'Olga', attributes: { ciudad: 'Tarija' } })).json().data;
    const { rows: otherList } = await h.owner.query('INSERT INTO contact_lists (area_id, name) VALUES ($1, $2) RETURNING id', [otherArea, `${h.prefix}-olvido`]);
    await h.owner.query("INSERT INTO contacts (area_id, list_id, email) VALUES ($1, $2, $3)", [otherArea, otherList[0].id, email.toUpperCase()]);
    const noReauth = await h.session((await h.owner.query('SELECT user_id FROM user_roles WHERE role_id = $1', [h.roles.admin])).rows[0].user_id, { reauth: false });
    assert.equal((await call('POST', '/api/v1/suppressions/anonymize', { email }, noReauth)).json().error.code, 'REAUTH_REQUIRED');
    const res = await call('POST', '/api/v1/suppressions/anonymize', { email }, adminToken);
    assert.equal(res.json().data.contacts, 2);
    const { rows } = await h.owner.query('SELECT email, first_name, attributes, anonymized_at FROM contacts WHERE id = $1', [contact.id]);
    assert.match(rows[0].email, /^anon-.+@anonimizado\.invalid$/);
    assert.equal(rows[0].first_name, null);
    assert.deepEqual(rows[0].attributes, {});
    const suppression = await h.owner.query("SELECT email, reason FROM suppressions WHERE email_hash = sha256(convert_to($1, 'UTF8'))", [email]);
    assert.deepEqual(suppression.rows[0], { email: null, reason: 'anonymized' });
    const { rows: audit } = await h.owner.query("SELECT metadata FROM audit_logs WHERE action = 'contact.anonymize' ORDER BY seq DESC LIMIT 1");
    assert.ok(!JSON.stringify(audit[0]).includes(email), 'la auditoría guarda el hash, no el email');
  });
});
