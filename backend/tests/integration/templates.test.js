// Templates end to end (Parte B, ADR-004, ADR-012): upload of a .docx,
// inspection in the isolated file-processor (ClamAV + package checks),
// conversion stored by the worker, isolated preview, area scope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { createQueue, QUEUES } from '../../src/core/queue/queues.js';
import { PREVIEW_CSP } from '../../src/modules/templates/templates.routes.js';
import { createHarness, multipart } from '../helpers/auth-fixtures.js';
import { docx, PNG } from '../helpers/docx.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

describe('plantillas', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let fileQueue;
  let token;
  let otherArea;
  const call = (method, url, payload) => h.request(method, url, { token, payload });
  const upload = (templateId, name, content) => h.request('POST', `/api/v1/templates/${templateId}/versions`, {
    token, ...multipart(name, content, DOCX),
  });

  async function waitVersion(templateId, version) {
    for (let i = 0; i < 120; i += 1) {
      const res = await call('GET', `/api/v1/templates/${templateId}/versions/${version}`);
      if (res.json().data.status !== 'pending') return res.json().data;
      await sleep(500);
    }
    throw new Error('version still pending');
  }

  before(async () => {
    fileQueue = createQueue(QUEUES.files, { url: readFileSync(process.env.REDIS_URL_FILE, 'utf8').trim() });
    h = await createHarness({ fileQueue });
    await h.role('operador', ['templates.view', 'templates.create', 'templates.update', 'templates.delete']);
    token = (await h.login((await h.localUser('operador', { roles: [h.roles.operador] })).username)).token;
    otherArea = await h.area('otra');
  });
  after(async () => {
    await fileQueue?.close();
    await h?.close();
  });

  it('sube una versión .docx: se inspecciona, se convierte y queda lista con sus variables', async () => {
    const template = (await call('POST', '/api/v1/templates', { name: 'Bienvenida', description: 'Correo de bienvenida' })).json().data;
    const res = await upload(template.id, 'bienvenida.docx', docx({ paragraphs: ['Hola {{first_name}}', 'Su plan: {{plan}}'], png: PNG }));
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().data.version, 1);
    const version = await waitVersion(template.id, 1);
    assert.equal(version.status, 'ready', JSON.stringify(version));
    assert.deepEqual(version.variables, ['first_name', 'plan']);
    assert.equal(version.images, 1);
    assert.match(version.text, /Hola \{\{first_name\}\}/);
    const detail = (await call('GET', `/api/v1/templates/${template.id}`)).json().data;
    assert.equal(detail.latestReadyVersion, 1);
    assert.equal((await h.audits('template.version_process', template.id))[0].result, 'success');
  });

  it('vista previa aislada: CSP con sandbox, sin scripts e imágenes como data:', async () => {
    const template = (await call('POST', '/api/v1/templates', { name: 'Vista previa' })).json().data;
    await upload(template.id, 'p.docx', docx({ paragraphs: ['Texto con <script>alert(1)</script>'], png: PNG }));
    await waitVersion(template.id, 1);
    const res = await call('GET', `/api/v1/templates/${template.id}/versions/1/preview`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-security-policy'], PREVIEW_CSP);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.ok(res.body.startsWith('<!doctype html>'), 'HTML sin serializar como JSON');
    assert.ok(!res.body.includes('<script'));
    assert.match(res.body, /src="data:image\/png;base64,/);
  });

  it('rechaza malware, macros, archivos que no son .docx y variables cortadas', async () => {
    const template = (await call('POST', '/api/v1/templates', { name: 'Riesgos' })).json().data;
    await upload(template.id, 'virus.docx', EICAR);
    assert.equal((await waitVersion(template.id, 1)).failureReason, 'malware');
    await upload(template.id, 'macro.docx', docx({ contentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' }));
    assert.equal((await waitVersion(template.id, 2)).failureReason, 'macros');
    await upload(template.id, 'cortada.docx', docx({ paragraphs: [{ runs: ['Hola {{nom', 'bre}}'] }] }));
    assert.equal((await waitVersion(template.id, 3)).failureReason, 'broken_variable');
    const doc = await upload(template.id, 'viejo.doc', 'binario');
    assert.equal(doc.json().error.details[0].code, 'not_docx');
    assert.equal((await call('GET', `/api/v1/templates/${template.id}/versions/3/preview`)).statusCode, 409);
  });

  it('alcance por área y archivado', async () => {
    const { rows } = await h.owner.query('INSERT INTO templates (area_id, name) VALUES ($1, $2) RETURNING id', [otherArea, `${h.prefix}-ajena`]);
    assert.equal((await call('GET', `/api/v1/templates/${rows[0].id}`)).statusCode, 404);
    assert.equal((await call('GET', `/api/v1/templates/${rows[0].id}/versions/1/preview`)).statusCode, 404);
    assert.ok(!(await call('GET', '/api/v1/templates')).json().data.some((t) => t.id === rows[0].id));
    const template = (await call('POST', '/api/v1/templates', { name: 'Archivable' })).json().data;
    assert.equal((await call('DELETE', `/api/v1/templates/${template.id}`)).json().data.isArchived, true);
    assert.ok(!(await call('GET', '/api/v1/templates')).json().data.some((t) => t.id === template.id));
    assert.equal((await upload(template.id, 'x.docx', docx())).statusCode, 409);
  });
});
