import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { areas, optionsOf } from './lookups.js';

const NAME_PATTERN = '[^\\r\\n<>"]+';

// Allowed senders per area (Parte B). The From must use the sending
// subdomain and the Reply-To a domain with mailboxes (Parameters).
export function render(container) {
  const table = dataTable({
    load: () => api.get('/api/v1/senders'),
    columns: [
      { key: 'areaName', label: t('users.area') },
      { key: 'email', label: t('senders.email'), render: (s) => el('code', { text: s.email }) },
      { key: 'displayName', label: t('senders.displayName') },
      { key: 'replyTo', label: t('senders.replyTo') },
      { key: 'isActive', label: t('users.statusLabel'), render: (s) => badge(s.isActive ? t('common.active') : t('common.inactive'), s.isActive ? 'ok' : 'muted') },
      { key: 'actions', label: '', render: (s) => button(t('common.edit'), () => edit(s)) },
    ],
  });

  async function edit(sender) {
    const areaList = sender ? [] : ((await run(areas)) ?? []).filter((a) => a.isActive);
    const fields = sender
      ? [
        { name: 'displayName', label: t('senders.displayName'), required: true, maxLength: 100, pattern: NAME_PATTERN, value: sender.displayName },
        { name: 'replyTo', label: t('senders.replyTo'), type: 'email', maxLength: 254, value: sender.replyTo ?? '' },
        { name: 'isActive', label: t('common.active'), type: 'checkbox', value: sender.isActive },
      ]
      : [
        { name: 'areaId', label: t('users.area'), type: 'select', required: true, options: [{ value: '', label: '—' }, ...optionsOf(areaList)] },
        { name: 'email', label: t('senders.email'), type: 'email', required: true, maxLength: 254, hint: t('senders.emailHint') },
        { name: 'displayName', label: t('senders.displayName'), required: true, maxLength: 100, pattern: NAME_PATTERN },
        { name: 'replyTo', label: t('senders.replyTo'), type: 'email', maxLength: 254, hint: t('senders.replyToHint') },
      ];
    const form = createForm({
      fields,
      submitLabel: t('common.save'),
      onSubmit: async (values) => {
        const body = { ...values, replyTo: values.replyTo || null };
        const result = await run(() => (sender ? api.patch(`/api/v1/senders/${sender.id}`, body) : api.post('/api/v1/senders', body)), { form });
        if (result) {
          toast(t('common.saved'), 'success');
          modal.close();
          table.refresh();
        }
      },
    });
    const modal = openModal({ title: sender ? t('senders.edit') : t('senders.create'), content: form.element });
  }

  replace(container, [
    pageHeader(t('nav.senders'), [button(t('senders.create'), () => edit(null), { kind: 'primary' })]),
    el('p', { text: t('senders.help') }),
    table.element,
  ]);
}
