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

export function render(container) {
  const table = dataTable({
    load: () => api.get('/api/v1/roles'),
    columns: [
      { key: 'name', label: t('roles.name'), render: (r) => el('a', { text: r.name, attrs: { href: `#/roles/${r.id}` } }) },
      { key: 'description', label: t('roles.description') },
      { key: 'permissions', label: t('roles.permissions'), render: (r) => String(r.permissions.length) },
      { key: 'userCount', label: t('roles.users') },
      {
        key: 'flags', label: '', render: (r) => el('span', {}, [
          r.isSystem ? badge(t('roles.system')) : null,
          r.administrative ? badge(t('roles.administrative'), 'warning') : null,
          r.usedFromAd ? badge(t('roles.usedFromAd')) : null,
        ]),
      },
    ],
  });
  replace(container, [
    pageHeader(t('nav.roles'), [auth.hasPermission('roles.create') ? button(t('roles.create'), () => createRole(), { kind: 'primary' }) : null]),
    table.element,
  ]);
}

function createRole() {
  const form = createForm({
    fields: [
      { name: 'name', label: t('roles.name'), required: true, pattern: '[a-z][a-z0-9_-]{1,49}', hint: t('roles.nameHint') },
      { name: 'description', label: t('roles.description'), type: 'textarea', maxLength: 500 },
    ],
    submitLabel: t('roles.create'),
    onSubmit: async (values) => {
      const result = await run(() => api.post('/api/v1/roles', values), { form });
      if (result) {
        modal.close();
        navigate(`/roles/${result.data.id}`);
      }
    },
  });
  const modal = openModal({ title: t('roles.create'), content: [el('p', { text: t('roles.createHelp') }), form.element] });
}
