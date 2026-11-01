import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { createFileStore } from '../../src/core/files/storage.js';
import { processTemplateDocx } from '../../src/modules/templates/files/template-docx.processor.js';
import { checkEntries, checkXmlPart, extractVariables, imageType } from '../../src/modules/templates/template-rules.js';
import { docx, PNG, zip } from '../helpers/docx.js';

const clean = { scan: async (stream) => { stream.resume(); await new Promise((resolve) => stream.on('end', resolve)); return { clean: true }; } };
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

describe('reglas de plantillas', () => {
  it('variables: solo {{nombre}}; rechaza otras sintaxis y variables cortadas por formato', () => {
    assert.deepEqual(extractVariables('<p>Hola {{ first_name }}, plan {{plan}}</p>'), { variables: ['first_name', 'plan'], problems: [] });
    assert.equal(extractVariables('<p>{{#if x}}</p>').problems[0].code, 'unsupported_syntax');
    assert.equal(extractVariables('<p>{{Nombre}}</p>').problems[0].code, 'unsupported_syntax');
    assert.equal(extractVariables('<p>{{nom<strong>bre</strong>}}</p>').problems[0].code, 'broken_variable');
    assert.equal(extractVariables('<p>{{{raw}}}</p>').problems.some((p) => p.code === 'broken_variable'), true);
  });

  it('paquete: zip bomb, rutas peligrosas, macros y partes prohibidas', () => {
    const ok = [{ name: '[Content_Types].xml', compressedSize: 10, uncompressedSize: 100 }];
    assert.equal(checkEntries(ok), null);
    assert.equal(checkEntries([...ok, { name: 'a', compressedSize: 1, uncompressedSize: 1000 }]), 'compression_ratio');
    assert.equal(checkEntries([...ok, { name: '../x', compressedSize: 1, uncompressedSize: 1 }]), 'invalid_entry_name');
    assert.equal(checkEntries([...ok, { name: 'word/vbaProject.bin', compressedSize: 1, uncompressedSize: 1 }]), 'forbidden_part');
    assert.equal(checkEntries([{ name: 'word/document.xml', compressedSize: 1, uncompressedSize: 1 }]), 'not_docx');
  });

  it('XML: sin DTD (XXE) ni referencias externas salvo enlaces https/mailto', () => {
    assert.equal(checkXmlPart('word/document.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>'), 'dtd');
    const rel = (type, target) => `<Relationships><Relationship Id="r" Type="${type}" Target="${target}" TargetMode="External"/></Relationships>`;
    assert.equal(checkXmlPart('word/_rels/document.xml.rels', rel(HYPERLINK, 'https://empresa.test')), null);
    assert.equal(checkXmlPart('word/_rels/document.xml.rels', rel(HYPERLINK, 'mailto:a@b.test')), null);
    assert.equal(checkXmlPart('word/_rels/document.xml.rels', rel(HYPERLINK, 'file:///c:/x')), 'external_reference');
    assert.equal(checkXmlPart('word/_rels/document.xml.rels', rel('http://x/relationships/image', 'http://remota/img.png')), 'external_reference');
    assert.equal(checkXmlPart('word/_rels/settings.xml.rels', rel('http://x/relationships/attachedTemplate', 'https://x/t.dotm')), 'forbidden_relationship');
  });

  it('imágenes por firma, no por extensión', () => {
    assert.equal(imageType(PNG), 'image/png');
    assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(imageType(Buffer.from('GIF89a......')), 'image/gif');
    assert.equal(imageType(Buffer.from('<svg onload=alert(1)>')), null);
  });
});

describe('inspección y conversión de .docx', () => {
  let dir;
  let store;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'enviotec-docx-'));
    store = createFileStore(dir);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const run = async (buffer) => {
    const saved = await store.saveIncoming(Readable.from([buffer]), { maxBytes: 20 * 1024 * 1024 });
    const outcome = await processTemplateDocx({ fileId: saved.id }, { store, clamav: clean });
    return { outcome, saved };
  };

  it('convierte a HTML sanitizado con variables, texto e imágenes inline (cid)', async () => {
    const { outcome, saved } = await run(docx({
      paragraphs: ['Hola {{first_name}}', 'Su plan es {{plan}} <script>alert(1)</script>'],
      png: PNG,
    }));
    assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
    assert.deepEqual(outcome.variables, ['first_name', 'plan']);
    const result = JSON.parse(await readFile(store.pathOf('results', saved.id), 'utf8'));
    assert.match(result.html, /<img [^>]*src="cid:img1@enviotec"/);
    assert.ok(!result.html.includes('<script'), 'el texto con < se escapa');
    assert.match(result.text, /Hola \{\{first_name\}\}/);
    assert.equal(result.images[0].contentType, 'image/png');
  });

  it('rechaza macros, DTD, plantillas adjuntas, enlaces peligrosos, variables cortadas y archivos que no son .docx', async () => {
    const macros = docx({ contentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' });
    assert.equal((await run(macros)).outcome.reason, 'macros');
    const vba = docx({ extraParts: { 'word/vbaProject.bin': 'x' } });
    assert.equal((await run(vba)).outcome.reason, 'forbidden_part');
    const dtd = docx({ extraParts: { 'word/settings.xml': '<!DOCTYPE s [<!ENTITY x SYSTEM "file:///etc/passwd">]><s/>' } });
    assert.equal((await run(dtd)).outcome.reason, 'dtd');
    const remote = docx({ documentRels: '<Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://rastreo.test/p.png" TargetMode="External"/>' });
    assert.equal((await run(remote)).outcome.reason, 'external_reference');
    const broken = docx({ paragraphs: [{ runs: ['Hola {{nom', 'bre}}'] }] });
    assert.equal((await run(broken)).outcome.reason, 'broken_variable');
    assert.equal((await run(Buffer.from('no es un zip'))).outcome.reason, 'not_docx');
    const bomb = zip({ '[Content_Types].xml': 'x', 'a.xml': Buffer.alloc(5 * 1024 * 1024) });
    assert.equal((await run(bomb)).outcome.reason, 'compression_ratio');
  });

  it('el archivo original se borra al terminar', async () => {
    const { saved } = await run(docx());
    await assert.rejects(readFile(store.pathOf('incoming', saved.id)), /ENOENT/);
  });
});
