// CSV rules for contact imports (Parte B, ADR-004), as pure functions. Used
// by the file-processor, which never touches the database.

export const FIXED_COLUMNS = Object.freeze(['email', 'first_name', 'last_name']);
export const LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxRows: 100000, maxErrors: 100, maxValue: 500 });
export const ATTRIBUTE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Control characters (except tab) are removed from every value.
const isControl = (code) => (code < 32 && code !== 9) || code === 127;

// Spreadsheets in Spanish locales export ";" instead of ",".
export function detectDelimiter(firstLine) {
  const count = (char) => firstLine.split(char).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

// Returns { columns } or { error }. Every column must be a fixed field or a
// declared attribute of the list; "email" is mandatory; no duplicates.
export function validateHeader(header, attributes) {
  const columns = header.map((name) => String(name).trim().toLowerCase());
  const allowed = new Set([...FIXED_COLUMNS, ...attributes]);
  const unknown = columns.filter((name) => !allowed.has(name));
  if (unknown.length > 0) return { error: 'unknown_columns', columns: unknown.slice(0, 20) };
  if (!columns.includes('email')) return { error: 'missing_email_column' };
  if (new Set(columns).size !== columns.length) return { error: 'duplicate_columns' };
  return { columns };
}

export function cleanValue(value) {
  return [...String(value ?? '')].filter((char) => !isControl(char.codePointAt(0))).join('').trim();
}

// Returns { contact } or { problems: [{ field, code }] }.
export function validateRow(values, columns) {
  if (values.length !== columns.length) return { problems: [{ field: '*', code: 'column_count' }] };
  const problems = [];
  const contact = { email: '', first_name: null, last_name: null, attributes: {} };
  columns.forEach((column, index) => {
    const value = cleanValue(values[index]);
    if (column === 'email') {
      contact.email = value.toLowerCase();
      if (!EMAIL.test(contact.email) || contact.email.length > 254) problems.push({ field: 'email', code: 'invalid_email' });
    } else if (value.length > (column === 'first_name' || column === 'last_name' ? 100 : LIMITS.maxValue)) {
      problems.push({ field: column, code: 'too_long' });
    } else if (column === 'first_name' || column === 'last_name') {
      contact[column] = value || null;
    } else if (value !== '') {
      contact.attributes[column] = value;
    }
  });
  return problems.length > 0 ? { problems } : { contact };
}
