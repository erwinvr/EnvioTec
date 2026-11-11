// Date variables (ADR-030): entered as DD/MM/AAAA (also D/M/AAAA), or as
// AAAA-MM-DD from a date picker; stored as AAAA-MM-DD so they compare and
// sort without ambiguity; shown and merged into emails as DD/MM/AAAA.

const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

// Returns AAAA-MM-DD, or null when the text is not a real date.
export function parseDate(value) {
  const text = String(value ?? '').trim();
  const dmy = DMY.exec(text);
  const iso = ISO.exec(text);
  const [day, month, year] = dmy ? [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])] : iso ? [Number(iso[3]), Number(iso[2]), Number(iso[1])] : [];
  if (!year || year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// AAAA-MM-DD to DD/MM/AAAA; anything else is returned unchanged.
export function formatDate(value) {
  const iso = ISO.exec(String(value ?? ''));
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value;
}

export const isDateVariable = (types, name) => types?.[name] === 'date';
