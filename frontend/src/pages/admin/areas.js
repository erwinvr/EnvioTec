import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader } from '../../components/page.js';
import { toast } from '../../components/toast.js';

export function render(container) {
  const table = dataTable({
    load: () => api.get('/api/v1/areas'),
    columns: [
      { key: 'name', label: t('areas.name') },
      { key: 'adDepartment', label: t('areas.adDepartment') },
      { key: 'isActive', label: t('users.statusLabel'), render: (a) => badge(a.isActive ? t('common.active') : t('common.inactive'), a.isActive ? 'ok' : 'muted') },
      { key: 'actions', label: '', render: (a) => button(t('common.edit'), () => edit(a)) },
    ],
  });

  function edit(area) {
    const form = createForm({
      fields: [
        { name: 'name', label: t('areas.name'), required: true, minLength: 2, maxLength: 100, value: area?.name },
        { name: 'adDepartment', label: t('areas.adDepartment'), maxLength: 200, value: area?.adDepartment ?? '', hint: t('areas.adDepartmentHint') },
        ...(area ? [{ name: 'isActive', label: t('common.active'), type: 'checkbox', value: area.isActive }] : []),
      ],
      submitLabel: t('common.save'),
      onSubmit: async (values) => {
        const body = { ...values, adDepartment: values.adDepartment || null };
        const result = await run(() => (area ? api.patch(`/api/v1/areas/${area.id}`, body) : api.post('/api/v1/areas', body)), { form });
        if (result) {
          toast(t('common.saved'), 'success');
          modal.close();
          table.refresh();
        }
      },
    });
    const modal = openModal({ title: area ? t('areas.edit') : t('areas.create'), content: form.element });
  }

  replace(container, [
    pageHeader(t('nav.areas'), [button(t('areas.create'), () => edit(null), { kind: 'primary' })]),
    el('p', { text: t('areas.help') }),
    table.element,
  ]);
}
