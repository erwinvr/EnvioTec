// Template rules (Parte B, ADR-004, ADR-013) as pure functions: limits of
// the .docx package, what its parts may contain, and the variable syntax.

export const LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxEntries: 2000,
  maxUncompressed: 50 * 1024 * 1024,
  maxRatio: 100,
  maxImages: 20,
  maxImageBytes: 1024 * 1024,
  maxImagesTotal: 5 * 1024 * 1024,
});

export const FIXED_VARIABLES = Object.freeze(['email', 'first_name', 'last_name']);
const VARIABLE = /^[a-z][a-z0-9_]{0,39}$/;
const MAIN_DOCUMENT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const FORBIDDEN_PARTS = [/vbaproject\.bin$/i, /^word\/embeddings\//i, /^word\/activex\//i, /\.(bin|exe|dll|js|vbs)$/i];
const FORBIDDEN_RELATIONSHIPS = /\/(attachedTemplate|aFChunk|oleObject|frame|subDocument|control|package)"?$/i;

// Zip entry checks before decompressing anything (zip bombs, macros).
export function checkEntries(entries) {
  if (entries.length > LIMITS.maxEntries) return 'too_many_entries';
  let total = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('/') || entry.name.includes('..') || entry.name.includes('\\')) return 'invalid_entry_name';
    if (FORBIDDEN_PARTS.some((pattern) => pattern.test(entry.name))) return 'forbidden_part';
    total += entry.uncompressedSize;
    if (total > LIMITS.maxUncompressed) return 'too_large_uncompressed';
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > LIMITS.maxRatio) return 'compression_ratio';
  }
  if (!entries.some((entry) => entry.name === '[Content_Types].xml')) return 'not_docx';
  return null;
}

export function checkContentTypes(xml) {
  if (/macroEnabled/i.test(xml)) return 'macros';
  if (!xml.includes(MAIN_DOCUMENT)) return 'not_docx';
  return null;
}

// Every XML part: no DTD (XXE) and no external targets except https/mailto
// hyperlinks; no attached templates, alt chunks or embedded objects.
export function checkXmlPart(name, xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return 'dtd';
  if (!name.endsWith('.rels')) return null;
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const type = /Type="([^"]*)"/.exec(tag)?.[1] ?? '';
    const target = /Target="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (FORBIDDEN_RELATIONSHIPS.test(type)) return 'forbidden_relationship';
    if (/TargetMode="External"/i.test(tag) && !(type === HYPERLINK && /^(https:|mailto:)/i.test(target))) return 'external_reference';
  }
  return null;
}

// PNG, JPEG or GIF by their first bytes (never by extension).
export function imageType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

// ADR-013: only {{name}}; anything else between braces is rejected, and so
// is a variable broken by formatting ("{{nom<b>bre</b>}}").
export function extractVariables(html) {
  const variables = new Set();
  const problems = [];
  const text = html.replace(/<[^>]*>/g, '');
  for (const match of html.matchAll(/\{\{([^{}<>]*)\}\}/g)) {
    const name = match[1].trim();
    if (!VARIABLE.test(name)) problems.push({ code: 'unsupported_syntax', token: match[0].slice(0, 60) });
    else variables.add(name);
  }
  const opened = (text.match(/\{\{/g) ?? []).length;
  const closedInHtml = [...html.matchAll(/\{\{([^{}<>]*)\}\}/g)].length;
  if (opened !== closedInHtml || /\{\{\{|\}\}\}/.test(text)) problems.push({ code: 'broken_variable' });
  return { variables: [...variables].sort(), problems };
}
