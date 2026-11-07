import { api } from '../../core/api.js';
import { el } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { badge, button } from '../../components/page.js';
import { toast } from '../../components/toast.js';

// Variables of a list (ADR-028): what a template can use, with the label
// people read. The fixed fields come first; a variable with data cannot be
// removed (the backend refuses it).

export const variableTag = (name) => `{{${name}}}`;

export const fixedFields = () => [
  { name: 'email', label: t('contacts.email') },
  { name: 'first_name', label: t('contacts.firstName') },
  { name: 'last_name', label: t('contacts.lastName') },
];

export function variablesSection(list, { canEdit, onChange }) {
  function openForm(variable) {
    const form = createForm({
      fields: variable
        ? [{ name: 'label', label: t('variables.label'), required: true, maxLength: 60, value: variable.label }]
        : [
          { name: 'label', label: t('variables.label'), required: true, maxLength: 60, hint: t('variables.labelHint') },
          { name: 'name', label: t('variables.name'), maxLength: 40, pattern: '[a-z][a-z0-9_]{0,39}', hint: t('variables.nameHint') },
        ],
      submitLabel: t('common.save'),
      onSubmit: async (values) => {
        const call = variable
          ? () => api.patch(`/api/v1/lists/${list.id}/variables/${encodeURIComponent(variable.name)}`, { label: values.label })
          : () => api.post(`/api/v1/lists/${list.id}/variables`, values.name ? values : { label: values.label });
        if (await run(call, { form })) {
          modal.close();
          toast(t('common.saved'), 'success');
          onChange();
        }
      },
    });
    const modal = openModal({ title: variable ? t('variables.edit') : t('variables.create'), content: form.element });
  }

  async function remove(variable) {
    if (!await confirmDialog({ title: t('variables.delete'), message: t('variables.deleteConfirm', { label: variable.label }), danger: true })) return;
    if (await run(() => api.delete(`/api/v1/lists/${list.id}/variables/${encodeURIComponent(variable.name)}`))) onChange();
  }

  const row = (variable, fixed) => el('tr', {}, [
    el('td', { text: variable.label }),
    el('td', {}, [el('code', { text: variableTag(variable.name) })]),
    el('td', {}, [fixed ? badge(t('variables.fixed')) : (canEdit ? el('span', { className: 'actions' }, [
      button(t('common.edit'), () => openForm(variable)),
      button(t('common.delete'), () => remove(variable), { kind: 'danger' }),
    ]) : '')]),
  ]);

  return [
    el('p', { className: 'hint', text: t('variables.help') }),
    el('table', { className: 'table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: t('variables.label') }), el('th', { text: t('variables.inTemplate') }), el('th', { text: '' })])]),
      el('tbody', {}, [...fixedFields().map((field) => row(field, true)), ...list.variables.map((variable) => row(variable, false))]),
    ]),
    canEdit ? el('div', { className: 'actions' }, [button(t('variables.create'), () => openForm(null), { kind: 'primary' })]) : null,
  ];
}
