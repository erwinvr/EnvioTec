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

const ATTRIBUTE = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = ['email', 'first_name', 'last_name'];
export const parseAttributes = (text) => text.split(/[\s,]+/).map((name) => name.trim().toLowerCase()).filter(Boolean);
export const invalidAttribute = (names) => names.find((name) => !ATTRIBUTE.test(name) || RESERVED.includes(name));

export function render(container) {
  const table = dataTable({
    load: () => api.get('/api/v1/lists'),
    columns: [
      { key: 'name', label: t('lists.name'), render: (l) => el('a', { text: l.name, attrs: { href: `#/contactos/${l.id}` } }) },
      { key: 'areaName', label: t('users.area') },
      { key: 'contactCount', label: t('lists.contacts') },
      { key: 'attributes', label: t('lists.attributes'), render: (l) => l.attributes.join(', ') || '—' },
    ],
  });

  async function create() {
    const form = createForm({
      fields: [
        { name: 'name', label: t('lists.name'), required: true, minLength: 2, maxLength: 100 },
        { name: 'description', label: t('roles.description'), type: 'textarea', maxLength: 500 },
        { name: 'attributes', label: t('lists.attributes'), hint: t('lists.attributesHint') },
      ],
      submitLabel: t('lists.create'),
      onSubmit: async (values) => {
        const attributes = parseAttributes(values.attributes);
        const invalid = invalidAttribute(attributes);
        if (invalid) {
          form.showErrors({ attributes: t('lists.invalidAttribute', { name: invalid }) }, t('errors.validation'));
          return;
        }
        const body = { name: values.name, description: values.description, attributes };
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
