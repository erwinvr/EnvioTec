import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { createFileStore } from '../../src/core/files/storage.js';
import {
  assertApprover, assertCancellable, assertReadyToSubmit, assertTestRecipient, assertTestSendsLeft, cleanSubject, editOutcome, missingVariables,
} from '../../src/modules/campaigns/campaign-rules.js';
import { processCampaignPdf } from '../../src/modules/campaigns/files/campaign-pdf.processor.js';
import { forbiddenNames, isPdfSignature } from '../../src/modules/campaigns/pdf-rules.js';
import { pdf } from '../helpers/pdf.js';

const code = (expected) => (error) => error.statusCode === expected || error.details?.some((d) => d.code === expected);

describe('reglas de campañas', () => {
  it('maker-checker: nadie aprueba lo que envió a aprobación', () => {
    assert.throws(() => assertApprover({ submitted_by: 'a' }, 'a'), code(409));
    assert.doesNotThrow(() => assertApprover({ submitted_by: 'a' }, 'b'));
  });

  it('editar: borrador sigue en borrador; aprobada vuelve a borrador y libera; enviando nunca', () => {
    assert.deepEqual(editOutcome({ status: 'draft' }), { backToDraft: false, releaseReservation: false });
    assert.deepEqual(editOutcome({ status: 'submitted' }), { backToDraft: true, releaseReservation: false });
    assert.deepEqual(editOutcome({ status: 'approved' }), { backToDraft: true, releaseReservation: true });
    assert.deepEqual(editOutcome({ status: 'scheduled' }), { backToDraft: true, releaseReservation: true });
    for (const status of ['sending', 'paused', 'completed', 'cancelled']) assert.throws(() => editOutcome({ status }), code(409));
    assert.throws(() => editOutcome({ status: 'approved', started_at: new Date() }), code(409));
    assert.doesNotThrow(() => assertCancellable({ status: 'paused' }));
    assert.throws(() => assertCancellable({ status: 'completed' }), code(409));
  });

  it('variables de la plantilla deben existir en la lista', () => {
    assert.deepEqual(missingVariables(['first_name', 'plan', 'ciudad'], ['ciudad']), ['plan']);
    const ready = { campaign: { subject: 'Hola' }, version: { status: 'ready', variables: ['plan'] }, list: { attributes: [] },
      sender: { is_active: true }, attachment: { status: 'ready' }, recipientsInList: 3 };
    assert.throws(() => assertReadyToSubmit(ready), code('missing_variable'));
    assert.throws(() => assertReadyToSubmit({ ...ready, version: { status: 'ready', variables: [] }, attachment: null }), code('attachment_missing'));
    assert.throws(() => assertReadyToSubmit({ ...ready, version: { status: 'ready', variables: [] }, recipientsInList: 0 }), code('empty_list'));
    assert.doesNotThrow(() => assertReadyToSubmit({ ...ready, version: { status: 'ready', variables: [] } }));
  });

  it('pruebas: solo al propio correo o a dominios internos, con límite diario; asunto sin saltos', () => {
    assert.doesNotThrow(() => assertTestRecipient('Ana@Empresa.test', { userEmail: 'ana@empresa.test', allowedDomains: [] }));
    assert.doesNotThrow(() => assertTestRecipient('x@interno.test', { userEmail: 'ana@empresa.test', allowedDomains: ['interno.test'] }));
    assert.throws(() => assertTestRecipient('x@gmail.com', { userEmail: 'ana@empresa.test', allowedDomains: ['interno.test'] }), code('test_recipient_not_allowed'));
    assert.throws(() => assertTestSendsLeft(5, 5), code(409));
    assert.doesNotThrow(() => assertTestSendsLeft(4, 5));
    assert.equal(cleanSubject('  Hola  '), 'Hola');
    assert.throws(() => cleanSubject('Hola\r\nBcc: x@y'), code('invalid_characters'));
    assert.throws(() => cleanSubject('Hola {{first_name}}'), code('invalid_characters'));
  });
});

describe('inspección del PDF adjunto', () => {
  let dir;
  let store;
  const clean = { scan: async (stream) => { stream.resume(); await new Promise((resolve) => stream.on('end', resolve)); return { clean: true }; } };
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'enviotec-pdf-'));
    store = createFileStore(dir);
  });
  after(() => rm(dir, { recursive: true, force: true }));
  const run = async (buffer) => {
    const saved = await store.saveIncoming(Readable.from([buffer]), { maxBytes: 10 * 1024 * 1024 });
    return { outcome: await processCampaignPdf({ fileId: saved.id }, { store, clamav: clean }), saved };
  };

  it('nombres prohibidos, incluso escritos con escapes #xx', () => {
    assert.deepEqual(forbiddenNames('<< /OpenAction 3 0 R /S /JavaScript >>').sort(), ['/JavaScript', '/OpenAction']);
    assert.deepEqual(forbiddenNames('<< /J#61vaScript (x) >>'), ['/JavaScript']);
    assert.deepEqual(forbiddenNames('<< /Type /Page /Font /F1 >>'), []);
    assert.equal(isPdfSignature(Buffer.from('%PDF-1.7')), true);
    assert.equal(isPdfSignature(Buffer.from('MZ\u0090')), false);
  });

  it('un PDF limpio se aprueba y queda el original listo para enviar', async () => {
    const original = pdf();
    const { outcome, saved } = await run(original);
    assert.deepEqual(outcome, { status: 'ok' });
    assert.ok((await readFile(store.pathOf('results', saved.id))).equals(original), 'se envía el original, no la copia normalizada');
  });

  it('rechaza JavaScript, acciones automáticas, cifrado, archivos que no son PDF y PDFs corruptos', async () => {
    const js = pdf({ extra: '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' });
    assert.equal((await run(js)).outcome.reason, 'active_content');
    assert.equal((await run(Buffer.from('no soy un pdf'))).outcome.reason, 'not_pdf');
    assert.equal((await run(Buffer.from('%PDF-1.4\nbasura sin estructura'))).outcome.reason, 'invalid_pdf');
    const plain = join(dir, 'plano.pdf');
    const encrypted = join(dir, 'cifrado.pdf');
    await writeFile(plain, pdf());
    execFileSync('qpdf', ['--encrypt', 'clave', 'clave', '256', '--', plain, encrypted]);
    assert.equal((await run(await readFile(encrypted))).outcome.reason, 'encrypted');
  });
});
