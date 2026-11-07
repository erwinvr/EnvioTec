// CSV rules for contact imports (Parte B, ADR-004), as pure functions. Used
// by the file-processor, which never touches the database.

export const FIXED_COLUMNS = Object.freeze(['email', 'first_name', 'last_name']);
export const LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024, maxRows: 100000, maxErrors: 100, maxValue: 500, maxColumns: 50, sampleRows: 3, previewValue: 100,
});
export const ATTRIBUTE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Control characters (except tab) are removed from every value.
const isControl = (code) => (code < 32 && code !== 9) || code === 127;

// Spreadsheets in Spanish locales export ";" instead of ",".
export function detectDelimiter(firstLine) {
  const count = (char) => firstLine.split(char).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

// Column mapping chosen by the user (ADR-028): one target per CSV column,
// in order; null means "do not import". Targets are a fixed field or a
// variable of the list; email is mandatory and no target is used twice.
// Returns { columns } or { error }.
export function validateMapping(mapping, header, attributes) {
  if (!Array.isArray(mapping) || mapping.length !== header.length) return { error: 'mapping_length' };
  const allowed = new Set([...FIXED_COLUMNS, ...attributes]);
  const targets = mapping.filter((target) => target !== null);
  if (targets.some((target) => !allowed.has(target))) return { error: 'unknown_target' };
  if (!targets.includes('email')) return { error: 'missing_email_column' };
  if (new Set(targets).size !== targets.length) return { error: 'duplicate_target' };
  return { columns: mapping };
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
    if (column === null) return;
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

// Header and sample shown to the user to choose the mapping: cleaned and
// cut, so a hostile file cannot inflate what is stored and displayed.
export function previewCells(record) {
  return record.slice(0, LIMITS.maxColumns).map((value) => cleanValue(value).slice(0, LIMITS.previewValue));
}

// Variables of a list (ADR-028): the technical name used in templates and a
// label for people. Names that repeat a fixed field in Spanish are refused
// for new variables, so nobody confuses "nombre" with {{first_name}}.
export const RESERVED_VARIABLES = Object.freeze([...FIXED_COLUMNS, 'nombre', 'nombres', 'apellido', 'apellidos', 'correo', 'mail', 'e_mail']);

export function variableNameFrom(label) {
  const name = String(label ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(name) ? name : `v_${name}`.slice(0, 40);
}
