import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { createClamav } from '../../src/core/files/clamav.js';
import { createFileStore, FileTooLargeError } from '../../src/core/files/storage.js';
import { maskEmail } from '../../src/core/privacy/mask.js';
import { cleanValue, detectDelimiter, validateHeader, validateRow } from '../../src/modules/contacts/csv-rows.js';
import { processContactsCsv } from '../../src/modules/contacts/files/contacts-csv.processor.js';
import { normalizeContact, safeFileName } from '../../src/modules/contacts/contacts.service.js';

const clean = { scan: async (stream) => { stream.resume(); await new Promise((resolve) => stream.on('end', resolve)); return { clean: true }; } };

describe('reglas del CSV de contactos', () => {
  it('detecta el delimitador y valida el encabezado contra los atributos de la lista', () => {
    assert.equal(detectDelimiter('email;first_name;ciudad'), ';');
    assert.equal(detectDelimiter('email,first_name'), ',');
    assert.deepEqual(validateHeader([' Email ', 'FIRST_NAME', 'ciudad'], ['ciudad']), { columns: ['email', 'first_name', 'ciudad'] });
    assert.deepEqual(validateHeader(['email', 'password'], []), { error: 'unknown_columns', columns: ['password'] });
    assert.equal(validateHeader(['first_name'], []).error, 'missing_email_column');
    assert.equal(validateHeader(['email', 'email'], []).error, 'duplicate_columns');
  });

  it('valida cada fila y limpia caracteres de control', () => {
    const columns = ['email', 'first_name', 'ciudad'];
    assert.deepEqual(validateRow([' ANA@Empresa.test ', 'Ana\u0007', 'La Paz'], columns).contact,
      { email: 'ana@empresa.test', first_name: 'Ana', last_name: null, attributes: { ciudad: 'La Paz' } });
    assert.equal(validateRow(['no-es-email', 'x', 'y'], columns).problems[0].code, 'invalid_email');
    assert.equal(validateRow(['a@b.test', 'x'.repeat(101), ''], columns).problems[0].code, 'too_long');
    assert.equal(validateRow(['a@b.test'], columns).problems[0].code, 'column_count');
    assert.equal(cleanValue('\u0000a\tb\r\n'), 'a\tb');
  });

  it('contacto manual: atributos solo de la lista', () => {
    assert.deepEqual(normalizeContact({ email: 'A@B.test', firstName: ' Ana ', attributes: { ciudad: 'Sucre' } }, ['ciudad']),
      { email: 'a@b.test', first_name: 'Ana', last_name: null, attributes: { ciudad: 'Sucre' } });
    assert.throws(() => normalizeContact({ email: 'a@b.test', attributes: { rol: 'x' } }, ['ciudad']), (e) => e.details[0].code === 'unknown_attribute');
    assert.throws(() => normalizeContact({ email: 'malo' }, []), (e) => e.details[0].code === 'invalid_email');
  });

  it('nombres de archivo y enmascarado de emails', () => {
    assert.equal(safeFileName('../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('lista\u0000.csv'), 'lista.csv');
    assert.equal(safeFileName(''), 'archivo');
    assert.equal(maskEmail('ana.perez@empresa.com'), 'a*******z@e*****a.com');
    assert.equal(maskEmail('a@b.co'), 'a*@b*.co');
    assert.equal(maskEmail('raro'), '***');
  });
});

describe('almacenamiento privado y procesador de CSV', () => {
  let dir;
  let store;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'enviotec-files-'));
    store = createFileStore(dir);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const upload = (text) => store.saveIncoming(Readable.from([Buffer.from(text)]), { maxBytes: 1024 * 1024 });

  it('guarda con nombre generado y SHA-256; rechaza lo que supera el límite sin dejar restos', async () => {
    const saved = await upload('email\na@b.test\n');
    assert.match(saved.id, /^[0-9a-f-]{36}$/);
    assert.equal(saved.sha256.length, 64);
    await assert.rejects(store.saveIncoming(Readable.from([Buffer.alloc(2048)]), { maxBytes: 1024 }), FileTooLargeError);
    assert.deepEqual((await readdir(join(dir, 'incoming'))).filter((name) => name.endsWith('.part')), []);
    assert.throws(() => store.pathOf('incoming', '../x'), /invalid file reference/);
    assert.throws(() => store.pathOf('../', saved.id), /invalid file reference/);
  });

  it('procesa filas válidas, duplicadas e inválidas, con ";" y BOM', async () => {
    const saved = await upload('﻿email;first_name;ciudad\nana@b.test;Ana;La Paz\nANA@b.test;Otra;Sucre\nmalo;X;Y\nluis@b.test;Luis;\n');
    const outcome = await processContactsCsv({ fileId: saved.id, attributes: ['ciudad'] }, { store, clamav: clean });
    assert.deepEqual({ ...outcome, errors: undefined }, { status: 'ok', totalRows: 4, valid: 2, rejected: 2, errors: undefined });
    assert.deepEqual(outcome.errors.map((e) => e.code).sort(), ['duplicate_in_file', 'invalid_email']);
    const lines = (await readFile(store.pathOf('results', saved.id), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((c) => c.email), ['ana@b.test', 'luis@b.test']);
    await assert.rejects(readFile(store.pathOf('incoming', saved.id)), /ENOENT/, 'el original se borra');
  });

  it('rechaza malware, columnas desconocidas, archivos binarios y vacíos', async () => {
    const infected = { scan: async (stream) => { stream.resume(); await new Promise((resolve) => stream.on('end', resolve)); return { clean: false, signature: 'Eicar-Test-Signature' }; } };
    const run = async (text, clamav = clean) => processContactsCsv({ fileId: (await upload(text)).id, attributes: [] }, { store, clamav });
    assert.deepEqual(await run('email\na@b.test\n', infected), { status: 'failed', reason: 'malware', signature: 'Eicar-Test-Signature' });
    assert.equal((await run('email,clave\na@b.test,x\n')).reason, 'unknown_columns');
    assert.equal((await run('PK\u0003\u0004\u0000\u0000binario')).reason, 'not_text');
    assert.equal((await run('')).reason, 'empty_file');
    assert.equal((await run('email\n"sin cerrar\n')).reason, 'invalid_csv');
  });

  it('si el antivirus no responde, el archivo queda para el reintento', async () => {
    const saved = await upload('email\na@b.test\n');
    const down = { scan: async () => { throw new Error('clamav timeout'); } };
    await assert.rejects(processContactsCsv({ fileId: saved.id, attributes: [] }, { store, clamav: down }));
    assert.ok(await readFile(store.pathOf('incoming', saved.id)));
  });
});

describe('cliente de ClamAV (protocolo INSTREAM)', () => {
  function fakeClamd(answer) {
    const server = net.createServer((socket) => {
      const chunks = [];
      socket.on('data', (data) => {
        chunks.push(data);
        const all = Buffer.concat(chunks);
        if (all.length >= 14 && all.subarray(-4).readUInt32BE() === 0) socket.end(`${answer}\0`);
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  it('interpreta OK y FOUND, y falla cerrado ante respuestas desconocidas', async () => {
    for (const [answer, expected] of [['stream: OK', { clean: true }], ['stream: Eicar-Test-Signature FOUND', { clean: false, signature: 'Eicar-Test-Signature' }]]) {
      const server = await fakeClamd(answer);
      const clamav = createClamav({ host: '127.0.0.1', port: server.address().port });
      assert.deepEqual(await clamav.scan(Readable.from([Buffer.from('contenido')])), expected);
      server.close();
    }
    const server = await fakeClamd('INSTREAM size limit exceeded. ERROR');
    const clamav = createClamav({ host: '127.0.0.1', port: server.address().port });
    await assert.rejects(clamav.scan(Readable.from([Buffer.from('x')])), /unexpected clamav answer/);
    server.close();
    await assert.rejects(createClamav({ host: '127.0.0.1', port: 1 }).scan(Readable.from([Buffer.from('x')])));
  });
});
