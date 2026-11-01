// PDF attachment rules (Parte B, ADR-004). Applied to the file normalized
// by qpdf (object streams disabled), so names cannot hide inside compressed
// streams; names may still be written with #xx escapes, which are decoded
// before matching.

export const MAX_BYTES = 5 * 1024 * 1024;
const FORBIDDEN = ['/JS', '/JavaScript', '/OpenAction', '/AA', '/Launch', '/EmbeddedFile', '/EmbeddedFiles', '/RichMedia', '/XFA', '/SubmitForm', '/ImportData', '/GoToR'];
const NAME = /\/[A-Za-z0-9#]+/g;

export function isPdfSignature(buffer) {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

const decodeName = (name) => name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

// Returns the forbidden names found (empty if none).
export function forbiddenNames(text) {
  const found = new Set();
  for (const match of text.matchAll(NAME)) {
    const name = decodeName(match[0]);
    if (FORBIDDEN.includes(name)) found.add(name);
  }
  return [...found];
}
