import { api } from '../../core/api.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { button } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { fixedFields, variableTag } from './list-variables.js';

// Second step of a CSV import (ADR-028): each column of the file, with its
// sample values, is assigned to a field or variable of the list, or skipped.
// The suggestion is only a convenience; the backend validates the mapping.

const SKIP = '';
// Usual headers for the fixed fields, compared without case or accents.
const ALIASES = {
  email: ['email', 'correo', 'correo_electronico', 'e_mail', 'mail'],
  first_name: ['first_name', 'nombre', 'nombres'],
  last_name: ['last_name', 'apellido', 'apellidos'],
};

export const normalize = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Suggested target for each header: a variable by name or label first, then
// a fixed field by its usual names; never the same target twice.
export function suggestMapping(header, variables) {
  const used = new Set();
  return header.map((column) => {
    const key = normalize(column);
    const variable = variables.find((v) => normalize(v.name) === key || normalize(v.label) === key);
    const fixed = Object.keys(ALIASES).find((name) => ALIASES[name].includes(key));
    const target = variable?.name ?? fixed ?? null;
    if (target === null || used.has(target)) return null;
    used.add(target);
    return target;
  });
}

export function openMapping(row, list, onDone) {
  const targets = [...fixedFields(), ...list.variables];
  const options = [
    { value: SKIP, label: t('imports.skipColumn') },
    ...targets.map((target) => ({ value: target.name, label: `${target.label} · ${variableTag(target.name)}` })),
  ];
  const suggested = suggestMapping(row.header, list.variables);
  const cancel = button(t('imports.cancel'), async () => {
    if (!await confirmDialog({ title: t('imports.cancel'), message: t('imports.cancelConfirm'), danger: true })) return;
    if (await run(() => api.delete(`/api/v1/imports/${row.id}`))) {
      modal.close();
      onDone();
    }
  }, { kind: 'danger' });
  const form = createForm({
    fields: row.header.map((column, index) => ({
      name: `col_${index}`, label: column || t('imports.unnamedColumn', { n: index + 1 }), type: 'select', options,
      value: suggested[index] ?? SKIP,
      hint: (row.sample ?? []).map((values) => values[index] ?? '').filter(Boolean).join(' · ') || t('imports.noSample'),
    })),
    submitLabel: t('imports.confirmMapping'),
    secondary: cancel,
    onSubmit: async (values) => {
      const mapping = row.header.map((_, index) => values[`col_${index}`] || null);
      const chosen = mapping.filter(Boolean);
      if (!chosen.includes('email')) {
        form.showErrors({}, t('validation.missing_email_column'));
        return;
      }
      if (new Set(chosen).size !== chosen.length) {
        form.showErrors({}, t('validation.duplicate_target'));
        return;
      }
      if (await run(() => api.post(`/api/v1/imports/${row.id}/mapping`, { mapping }), { form })) {
        modal.close();
        toast(t('imports.mappingQueued'), 'success');
        onDone();
      }
    },
  });
  const modal = openModal({ title: t('imports.mapTitle', { file: row.originalName }), content: form.element, wide: true });
}
