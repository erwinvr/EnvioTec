import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { button, pageHeader } from '../../components/page.js';
import { toast } from '../../components/toast.js';

// Global suppression list (Parte B). Only manual entries can be removed.
export function render(container) {
  const manage = auth.hasPermission('suppressions.manage');
  const table = dataTable({
    load: (query) => api.get('/api/v1/suppressions', query),
    filters: [{ name: 'search', label: t('suppressions.search') }],
    columns: [
      { key: 'email', label: t('users.email'), render: (s) => s.email ?? t('suppressions.anonymizedEmail') },
      { key: 'reason', label: t('suppressions.reason'), render: (s) => t(`suppressions.reasons.${s.reason}`) },
      { key: 'createdAt', label: t('audit.date'), render: (s) => formatDate(s.createdAt) },
      { key: 'createdBy', label: t('audit.actor') },
      {
        key: 'actions', label: '', render: (s) => (manage && s.reason === 'manual' ? button(t('common.delete'), async () => {
          if (!await confirmDialog({ title: t('suppressions.remove'), message: t('suppressions.removeConfirm'), danger: true })) return;
          if (await run(() => api.delete(`/api/v1/suppressions/${s.id}`))) table.refresh();
        }, { kind: 'danger' }) : ''),
      },
    ],
  });

  function emailForm({ title, intro, confirm, action }) {
    const form = createForm({
      fields: [{ name: 'email', label: t('users.email'), type: 'email', required: true, maxLength: 254 }],
      submitLabel: title,
      onSubmit: async (values) => {
        if (confirm && !await confirmDialog({ title, message: confirm, danger: true })) return;
        const result = await run(() => action(values), { form });
        if (result) {
          modal.close();
          table.refresh();
          toast(t('common.saved'), 'success');
        }
      },
    });
    const modal = openModal({ title, content: [el('p', { text: intro }), form.element] });
  }

  replace(container, [
    pageHeader(t('nav.suppressions'), manage ? [
      button(t('suppressions.add'), () => emailForm({
        title: t('suppressions.add'), intro: t('suppressions.addHelp'), action: (values) => api.post('/api/v1/suppressions', values),
      })),
      button(t('suppressions.anonymize'), () => emailForm({
        title: t('suppressions.anonymize'), intro: t('suppressions.anonymizeHelp'), confirm: t('suppressions.anonymizeConfirm'),
        action: (values) => api.post('/api/v1/suppressions/anonymize', values),
      }), { kind: 'danger' }),
    ] : []),
    el('p', { text: t('suppressions.help') }),
    table.element,
  ]);
}
