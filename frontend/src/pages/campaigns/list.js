import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { navigate } from '../../core/router.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader } from '../../components/page.js';

export const STATUSES = ['draft', 'submitted', 'approved', 'scheduled', 'sending', 'paused', 'completed', 'cancelled'];
export const statusBadge = (status) => badge(t(`campaigns.status.${status}`), { approved: 'ok', scheduled: 'ok', completed: 'ok', cancelled: 'muted', submitted: 'warning' }[status] ?? '');

// Local date-time input <-> ISO (America/La_Paz, Parte B).
export const toIso = (local) => (local ? new Date(`${local}:00-04:00`).toISOString() : null);

export async function campaignForm({ campaign, onSaved }) {
  const [templates, lists, senders] = await Promise.all([
    run(() => api.get('/api/v1/templates')), run(() => api.get('/api/v1/lists')), run(() => api.get('/api/v1/senders')),
  ]);
  const options = (items, label) => [{ value: '', label: '—' }, ...(items?.data ?? []).map((item) => ({ value: item.id, label: label(item) }))];
  const form = createForm({
    fields: [
      { name: 'name', label: t('campaigns.name'), required: true, minLength: 2, maxLength: 150, value: campaign?.name },
      { name: 'subject', label: t('campaigns.subject'), required: true, maxLength: 200, value: campaign?.subject, hint: t('campaigns.subjectHint') },
      {
        name: 'templateId', label: t('nav.templates'), type: 'select', required: true, value: campaign?.template.id,
        options: options({ data: (templates?.data ?? []).filter((tpl) => tpl.latestReadyVersion) }, (tpl) => `${tpl.name} (v${tpl.latestReadyVersion})`),
      },
      { name: 'listId', label: t('lists.name'), type: 'select', required: true, value: campaign?.list.id, options: options(lists, (l) => `${l.name} (${l.contactCount})`) },
      { name: 'senderId', label: t('campaigns.sender'), type: 'select', required: true, value: campaign?.sender.id, options: options(senders, (s) => `${s.displayName} <${s.email}>`) },
      { name: 'scheduledAt', label: t('campaigns.scheduledAt'), type: 'datetime-local', hint: t('campaigns.scheduledHint') },
    ],
    submitLabel: t('common.save'),
    onSubmit: async (values) => {
      const body = { ...values, scheduledAt: toIso(values.scheduledAt) };
      const result = await run(() => (campaign ? api.patch(`/api/v1/campaigns/${campaign.id}`, body) : api.post('/api/v1/campaigns', body)), { form });
      if (result) onSaved(result.data);
    },
  });
  return form;
}

export function render(container) {
  const table = dataTable({
    load: (query) => api.get('/api/v1/campaigns', query),
    filters: [{ name: 'status', label: t('users.statusLabel'), type: 'select', options: STATUSES.map((s) => ({ value: s, label: t(`campaigns.status.${s}`) })) }],
    columns: [
      { key: 'name', label: t('campaigns.name'), render: (c) => el('a', { text: c.name, attrs: { href: `#/campanias/${c.id}` } }) },
      { key: 'status', label: t('users.statusLabel'), render: (c) => statusBadge(c.status) },
      { key: 'list', label: t('lists.name'), render: (c) => c.list.name },
      { key: 'recipientCount', label: t('campaigns.recipients'), render: (c) => c.recipientCount ?? '—' },
      { key: 'scheduledAt', label: t('campaigns.scheduledAt'), render: (c) => formatDate(c.scheduledAt) },
      { key: 'createdBy', label: t('campaigns.createdBy') },
    ],
  });

  async function create() {
    const form = await campaignForm({
      onSaved: (campaign) => {
        modal.close();
        navigate(`/campanias/${campaign.id}`);
      },
    });
    const modal = openModal({ title: t('campaigns.create'), content: form.element, wide: true });
  }

  replace(container, [
    pageHeader(t('nav.campaigns'), [auth.hasPermission('campaigns.create') ? button(t('campaigns.create'), create, { kind: 'primary' }) : null]),
    table.element,
  ]);
}
