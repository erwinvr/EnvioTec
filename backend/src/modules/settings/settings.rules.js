import { ValidationError } from '../../core/errors/errors.js';

// Validation of system parameters (Parte B). The database checks the ranges
// again (CHECK on system_settings); these rules add the list formats and the
// consistency between parameters.

const MAX_LIST = 50;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LABEL_CHARS = /^[a-z0-9-]+$/;

const isLabel = (label) => label.length >= 1 && label.length <= 63 && LABEL_CHARS.test(label)
  && !label.startsWith('-') && !label.endsWith('-');
const isDomain = (value) => value.length <= 253 && value.split('.').length >= 2 && value.split('.').every(isLabel);
const invalid = (code, message) => new ValidationError([{ field: 'value', code }], message);

// Parameters that must not exceed another one.
const NOT_ABOVE = {
  'local_account.default_validity_days': 'local_account.max_validity_days',
  'local_account.renewal_max_days': 'local_account.max_validity_days',
};

export function normalizeSettingValue(setting, value) {
  if (setting.value_type === 'integer') {
    if (!Number.isInteger(value)) throw invalid('invalid_type');
    if (value < setting.min_value || value > setting.max_value) {
      throw invalid('out_of_range', `El valor debe estar entre ${setting.min_value} y ${setting.max_value}`);
    }
    return value;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw invalid('invalid_type');
  if (value.length > MAX_LIST) throw invalid('too_many_items');
  const items = [...new Set(value.map((item) => item.trim().toLowerCase()))];
  const valid = setting.value_type === 'email_list'
    ? (item) => item.length <= 254 && EMAIL.test(item)
    : isDomain;
  if (items.some((item) => !valid(item))) throw invalid(setting.value_type === 'email_list' ? 'invalid_email' : 'invalid_domain');
  return items;
}

// `values` maps every key to its current value.
export function assertConsistent(key, value, values) {
  const upper = NOT_ABOVE[key];
  if (upper && value > values[upper]) throw invalid('above_maximum', `No puede superar ${upper} (${values[upper]})`);
  for (const [lower, limit] of Object.entries(NOT_ABOVE)) {
    if (limit === key && values[lower] > value) throw invalid('below_dependent', `${lower} (${values[lower]}) no puede quedar por encima`);
  }
}
