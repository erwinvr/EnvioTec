import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { navigate } from '../../core/router.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader } from '../../components/page.js';
import { areas, optionsOf } from '../admin/lookups.js';

export function render(container) {
  const table = dataTable({
    load: () => api.get('/api/v1/templates'),
    columns: [
      { key: 'name', label: t('templates.name'), render: (tp) => el('a', { text: tp.name, attrs: { href: `#/plantillas/${tp.id}` } }) },
      { key: 'areaName', label: t('users.area') },
      { key: 'description', label: t('roles.description') },
      { key: 'latestReadyVersion', label: t('templates.readyVersion'), render: (tp) => (tp.latestReadyVersion ? `v${tp.latestReadyVersion}` : badge(t('templates.noVersion'))) },
    ],
  });

  async function create() {
    const viewAll = auth.hasPermission('areas.view_all');
    const areaList = viewAll ? ((await run(areas)) ?? []).filter((a) => a.isActive) : [];
    const form = createForm({
      fields: [
        { name: 'name', label: t('templates.name'), required: true, minLength: 2, maxLength: 100 },
        { name: 'description', label: t('roles.description'), type: 'textarea', maxLength: 500 },
        ...(viewAll ? [{ name: 'areaId', label: t('users.area'), type: 'select', required: true, options: [{ value: '', label: '—' }, ...optionsOf(areaList)] }] : []),
      ],
      submitLabel: t('templates.create'),
      onSubmit: async (values) => {
        const body = { name: values.name, description: values.description };
        if (viewAll) body.areaId = values.areaId;
        const result = await run(() => api.post('/api/v1/templates', body), { form });
        if (result) {
          modal.close();
          navigate(`/plantillas/${result.data.id}`);
        }
      },
    });
    const modal = openModal({ title: t('templates.create'), content: form.element });
  }

  replace(container, [
    pageHeader(t('nav.templates'), [auth.hasPermission('templates.create') ? button(t('templates.create'), create, { kind: 'primary' }) : null]),
    table.element,
  ]);
}
