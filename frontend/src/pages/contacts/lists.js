import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { navigate } from '../../core/router.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { button, pageHeader } from '../../components/page.js';

export function render(container) {
  const table = dataTable({
    load: () => api.get('/api/v1/lists'),
    columns: [
      { key: 'name', label: t('lists.name'), render: (l) => el('a', { text: l.name, attrs: { href: `#/contactos/${l.id}` } }) },
      { key: 'areaName', label: t('users.area') },
      { key: 'contactCount', label: t('lists.contacts') },
      { key: 'variables', label: t('variables.title'), render: (l) => l.variables.map((v) => v.label).join(', ') || '—' },
    ],
  });

  async function create() {
    const form = createForm({
      fields: [
        { name: 'name', label: t('lists.name'), required: true, minLength: 2, maxLength: 100 },
        { name: 'description', label: t('roles.description'), type: 'textarea', maxLength: 500 },
      ],
      submitLabel: t('lists.create'),
      onSubmit: async (values) => {
        // Variables are added afterwards, in the list's own page (ADR-028).
        const body = { name: values.name, description: values.description };
        const result = await run(() => api.post('/api/v1/lists', body), { form });
        if (result) {
          modal.close();
          navigate(`/contactos/${result.data.id}`);
        }
      },
    });
    const modal = openModal({ title: t('lists.create'), content: form.element });
  }

  replace(container, [
    pageHeader(t('nav.contacts'), [auth.hasPermission('contacts.create') ? button(t('lists.create'), create, { kind: 'primary' }) : null]),
    table.element,
  ]);
}
