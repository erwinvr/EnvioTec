import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { button, pageHeader } from '../../components/page.js';
import { toast } from '../../components/toast.js';

const show = (setting) => (Array.isArray(setting.value) ? setting.value.join(', ') || '—' : String(setting.value));

export function render(container) {
  const table = dataTable({
    rowKey: 'key',
    load: () => api.get('/api/v1/settings'),
    columns: [
      { key: 'key', label: t('settings.key'), render: (s) => el('code', { text: s.key }) },
      { key: 'description', label: t('settings.description') },
      { key: 'value', label: t('settings.value'), render: show },
      { key: 'range', label: t('settings.range'), render: (s) => (s.type === 'integer' ? `${s.min} – ${s.max}` : '—') },
      { key: 'actions', label: '', render: (s) => button(t('common.edit'), () => edit(s)) },
    ],
  });

  function edit(setting) {
    const isList = setting.type !== 'integer';
    const form = createForm({
      fields: [isList
        ? { name: 'value', label: setting.key, type: 'textarea', value: setting.value.join('\n'), hint: t('settings.listHint') }
        : { name: 'value', label: setting.key, type: 'number', required: true, min: setting.min, max: setting.max, value: setting.value }],
      submitLabel: t('common.save'),
      onSubmit: async ({ value }) => {
        const body = { value: isList ? value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) : value };
        if (await run(() => api.patch(`/api/v1/settings/${encodeURIComponent(setting.key)}`, body), { form })) {
          toast(t('common.saved'), 'success');
          modal.close();
          table.refresh();
        }
      },
    });
    const modal = openModal({ title: t('settings.edit'), content: [el('p', { text: setting.description }), form.element] });
  }

  replace(container, [pageHeader(t('nav.settings')), el('p', { text: t('settings.help') }), table.element]);
}
