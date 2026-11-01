import { el, replace } from '../core/dom.js';
import { t } from '../core/i18n.js';

// Form with UX validation that mirrors the backend schema (A9: never a
// security control). Field: { name, label, type, required, minLength,
// maxLength, pattern, min, max, options, hint, autocomplete, value, rows }.
// onSubmit(values) may return a promise; the form shows itself busy.

export function validateField(field, value) {
  const empty = value === '' || value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  if (empty) return field.required ? t('validation.required') : null;
  if (typeof value === 'string') {
    if (field.minLength && [...value].length < field.minLength) return t('validation.too_short_n', { n: field.minLength });
    if (field.maxLength && [...value].length > field.maxLength) return t('validation.too_long_n', { n: field.maxLength });
    if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(value)) return field.patternMessage ?? t('validation.invalid_format');
  }
  if (field.type === 'number') {
    const number = Number(value);
    if (!Number.isInteger(number)) return t('validation.invalid_type');
    if (field.min !== undefined && number < field.min) return t('validation.too_small_n', { n: field.min });
    if (field.max !== undefined && number > field.max) return t('validation.too_large_n', { n: field.max });
  }
  if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return t('validation.invalid_email');
  return null;
}

function control(field) {
  const id = `field-${field.name}`;
  const common = { id, name: field.name, autocomplete: field.autocomplete ?? 'off', 'aria-describedby': `${id}-error` };
  if (field.type === 'select') {
    return el('select', { attrs: common }, (field.options ?? []).map((option) =>
      el('option', { text: option.label, value: option.value, attrs: { selected: option.value === field.value } })));
  }
  if (field.type === 'checkboxes') {
    return el('div', { className: 'checkbox-group', attrs: { id, role: 'group' } }, (field.options ?? []).map((option) =>
      el('label', { className: 'checkbox' }, [
        el('input', { attrs: { type: 'checkbox', name: field.name, value: option.value }, checked: (field.value ?? []).includes(option.value) }),
        el('span', { text: option.label }),
        option.badge ? el('span', { className: 'badge', text: option.badge }) : null,
      ])));
  }
  if (field.type === 'checkbox') {
    return el('input', { attrs: { ...common, type: 'checkbox' }, checked: field.value === true });
  }
  if (field.type === 'textarea') {
    return el('textarea', { attrs: { ...common, rows: field.rows ?? 3 }, value: field.value ?? '' });
  }
  return el('input', {
    attrs: { ...common, type: field.type ?? 'text', inputmode: field.inputmode, min: field.min, max: field.max },
    value: field.value ?? '',
  });
}

function readValue(form, field) {
  if (field.type === 'checkboxes') {
    return [...form.querySelectorAll(`input[name="${field.name}"]:checked`)].map((input) => input.value);
  }
  const input = form.elements.namedItem(field.name);
  if (field.type === 'checkbox') return input.checked;
  if (field.type === 'number') return input.value === '' ? '' : Number(input.value);
  return field.trim === false ? input.value : input.value.trim();
}

export function createForm({ fields, submitLabel, onSubmit, secondary }) {
  const errorBox = el('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const submit = el('button', { className: 'button button-primary', text: submitLabel, attrs: { type: 'submit' } });
  const rows = fields.map((field) => el('div', { className: `field field-${field.type ?? 'text'}`, dataset: { field: field.name } }, [
    el('label', { text: field.label, attrs: { for: `field-${field.name}` } }),
    control(field),
    field.hint ? el('small', { className: 'hint', text: field.hint }) : null,
    el('small', { className: 'field-error', attrs: { id: `field-${field.name}-error` } }),
  ]));
  const form = el('form', { className: 'form', attrs: { novalidate: true } },
    [errorBox, ...rows, el('div', { className: 'actions' }, [secondary, submit])]);

  const api = {
    element: form,
    showErrors(fieldErrors = {}, message) {
      for (const row of rows) {
        const text = fieldErrors[row.dataset.field] ?? '';
        row.querySelector('.field-error').textContent = text;
        row.classList.toggle('has-error', text !== '');
      }
      const generic = Object.keys(fieldErrors).some((name) => !fields.some((field) => field.name === name));
      errorBox.textContent = message ?? '';
      errorBox.hidden = !message && !generic;
    },
    values() {
      return Object.fromEntries(fields.map((field) => [field.name, readValue(form, field)]));
    },
    setBusy(busy) {
      submit.disabled = busy;
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
    },
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = api.values();
    const errors = {};
    for (const field of fields) {
      const problem = validateField(field, values[field.name]);
      if (problem) errors[field.name] = problem;
    }
    api.showErrors(errors, Object.keys(errors).length > 0 ? t('errors.validation') : null);
    if (Object.keys(errors).length > 0) return;
    api.setBusy(true);
    try {
      await onSubmit(values, api);
    } finally {
      api.setBusy(false);
    }
  });
  return api;
}

export function replaceForm(container, form) {
  replace(container, form.element);
  form.element.querySelector('input, select, textarea')?.focus();
}
