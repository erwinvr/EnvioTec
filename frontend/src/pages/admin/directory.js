import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { button, pageHeader } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { optionsOf, roles } from './lookups.js';

// AD group -> business role (ADR-007). Administrative roles are not offered.
export function render(container) {
  const table = dataTable({
    load: () => api.get('/api/v1/directory/mappings'),
    columns: [
      { key: 'groupDn', label: t('directory.groupDn'), render: (m) => el('code', { text: m.groupDn }) },
      { key: 'roleName', label: t('directory.role') },
      {
        key: 'actions', label: '', render: (m) => button(t('common.delete'), async () => {
          if (!await confirmDialog({ title: t('directory.delete'), message: t('directory.deleteConfirm'), danger: true })) return;
          if (await run(() => api.delete(`/api/v1/directory/mappings/${m.id}`))) {
            toast(t('common.saved'), 'success');
            table.refresh();
          }
        }, { kind: 'danger' }),
      },
    ],
  });

  async function create() {
    const roleList = ((await run(roles)) ?? []).filter((role) => !role.administrative);
    const form = createForm({
      fields: [
        { name: 'groupDn', label: t('directory.groupDn'), required: true, minLength: 3, maxLength: 500, hint: t('directory.groupDnHint') },
        { name: 'roleId', label: t('directory.role'), type: 'select', required: true, options: [{ value: '', label: '—' }, ...optionsOf(roleList)] },
      ],
      submitLabel: t('common.save'),
      onSubmit: async (values) => {
        if (await run(() => api.post('/api/v1/directory/mappings', values), { form })) {
          toast(t('common.saved'), 'success');
          modal.close();
          table.refresh();
        }
      },
    });
    const modal = openModal({ title: t('directory.create'), content: form.element });
  }

  replace(container, [
    pageHeader(t('nav.directory'), [button(t('directory.create'), create, { kind: 'primary' })]),
    el('p', { text: t('directory.help') }),
    table.element,
  ]);
}
