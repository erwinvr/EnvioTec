import { randomUUID, createHash } from 'node:crypto';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import yauzl from 'yauzl';
import { checkContentTypes, checkEntries, checkXmlPart, extractVariables, imageType, LIMITS } from '../template-rules.js';

// Inspection and conversion of a .docx template inside the file-processor
// (ADR-004, ADR-013): antivirus; zip directory checked before inflating
// anything; macros, DTDs, external references, alt chunks and embedded
// objects rejected; conversion with mammoth; strict sanitization; images
// kept as inline (cid) attachments; variables validated.

const SANITIZE = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'a', 'img', 'blockquote', 'hr'],
  allowedAttributes: { a: ['href'], img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
  allowedSchemes: ['https', 'mailto'],
  allowedSchemesByTag: { img: ['cid'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

const openZip = (buffer) => new Promise((resolve, reject) => {
  yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => (error ? reject(error) : resolve(zip)));
});

async function readEntries(buffer) {
  const zip = await openZip(buffer);
  const entries = [];
  await new Promise((resolve, reject) => {
    zip.on('entry', (entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  return { zip, entries };
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
      return undefined;
    });
  });
}

async function inspectPackage(buffer) {
  let opened;
  try {
    opened = await readEntries(buffer);
  } catch {
    return 'not_docx';
  }
  const { zip, entries } = opened;
  const entryProblem = checkEntries(entries.map((e) => ({ name: e.fileName, compressedSize: e.compressedSize, uncompressedSize: e.uncompressedSize })));
  if (entryProblem) return entryProblem;
  // yauzl reads from the buffer; entries can be opened again after "end".
  const reopened = await openZip(buffer);
  const all = [];
  await new Promise((resolve, reject) => {
    reopened.on('entry', (entry) => { all.push(entry); reopened.readEntry(); });
    reopened.on('end', resolve);
    reopened.on('error', reject);
    reopened.readEntry();
  });
  zip.close();
  for (const entry of all) {
    if (!/\.(xml|rels)$/i.test(entry.fileName)) continue;
    const xml = (await readEntry(reopened, entry)).toString('utf8');
    const problem = entry.fileName === '[Content_Types].xml' ? checkContentTypes(xml) ?? checkXmlPart(entry.fileName, xml) : checkXmlPart(entry.fileName, xml);
    if (problem) return problem;
  }
  return null;
}

export async function processTemplateDocx(data, deps) {
  const outcome = await inspect(data, deps);
  await deps.store.remove('incoming', data.fileId);
  return outcome;
}

async function inspect({ fileId }, { store, clamav }) {
  const scan = await clamav.scan(store.read('incoming', fileId));
  if (!scan.clean) return { status: 'failed', reason: 'malware', signature: scan.signature };
  if (await store.size('incoming', fileId) > LIMITS.maxBytes) return { status: 'failed', reason: 'too_large' };

  const chunks = [];
  for await (const chunk of store.read('incoming', fileId)) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const packageProblem = await inspectPackage(buffer);
  if (packageProblem) return { status: 'failed', reason: packageProblem };

  const images = [];
  let imageProblem = null;
  let imagesTotal = 0;
  const convertImage = mammoth.images.imgElement(async (image) => {
    const content = await image.read();
    const type = imageType(content);
    imagesTotal += content.length;
    if (!type) imageProblem ??= 'image_type';
    else if (content.length > LIMITS.maxImageBytes) imageProblem ??= 'image_too_large';
    else if (images.length >= LIMITS.maxImages) imageProblem ??= 'too_many_images';
    else if (imagesTotal > LIMITS.maxImagesTotal) imageProblem ??= 'images_too_large';
    if (imageProblem) return { src: '' };
    const id = randomUUID();
    const output = await store.writer('results', id);
    await new Promise((resolve, reject) => output.end(content, (error) => (error ? reject(error) : resolve())));
    const cid = `img${images.length + 1}@enviotec`;
    images.push({ cid, fileId: id, contentType: type, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    return { src: `cid:${cid}`, alt: image.altText ?? '' };
  });

  let converted;
  try {
    converted = await mammoth.convertToHtml({ buffer }, { convertImage, ignoreEmptyParagraphs: true });
  } catch {
    return { status: 'failed', reason: 'conversion_failed', imageFiles: images.map((image) => image.fileId) };
  }
  if (imageProblem) return { status: 'failed', reason: imageProblem, imageFiles: images.map((image) => image.fileId) };

  const html = sanitizeHtml(converted.value, SANITIZE);
  const text = sanitizeHtml(html.replace(/<\/(p|h[1-6]|li|tr|blockquote)>/g, '\n').replace(/<br\s*\/?>/g, '\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/\n{3,}/g, '\n\n').trim();
  const { variables, problems } = extractVariables(html);
  if (problems.length > 0) return { status: 'failed', reason: problems[0].code, detail: problems[0].token ?? null, imageFiles: images.map((image) => image.fileId) };
  if (text.length === 0) return { status: 'failed', reason: 'empty_document', imageFiles: images.map((image) => image.fileId) };

  const output = await store.writer('results', fileId);
  await new Promise((resolve, reject) => output.end(JSON.stringify({ html, text, variables, images }), (error) => (error ? reject(error) : resolve())));
  return { status: 'ok', variables, imageCount: images.length, warnings: converted.messages.length };
}
