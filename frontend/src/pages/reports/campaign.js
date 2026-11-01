import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, definitionList, pageHeader, section } from '../../components/page.js';
import { saveResponse } from '../download.js';
import { opensNote, rate } from './campaigns.js';

const STATUS_FILTERS = ['sent', 'rejected', 'suppressed', 'pending', 'not_sent'];
const EVENT_FILTERS = ['delivered', 'opened', 'clicked', 'hard_bounce', 'soft_bounce', 'complaint', 'unsubscribe'];
const FLAGS = ['hardBounce', 'softBounce', 'complaint', 'unsubscribed'];

// Columns shared with the per-contact report.
export const recipientColumns = () => [
  { key: 'status', label: t('users.statusLabel'), render: (r) => t(`campaigns.recipientStatus.${r.status}`) },
  { key: 'delivered', label: t('reports.stats.delivered'), render: (r) => (r.delivered ? badge(t('reports.stats.delivered'), 'ok') : '—') },
  { key: 'opens', label: t('reports.opens') },
  { key: 'clicks', label: t('reports.clicks') },
  {
    key: 'flags', label: t('reports.flags'),
    render: (r) => el('span', {}, FLAGS.filter((flag) => r[flag]).map((flag) => badge(t(`reports.flag.${flag}`), 'warning'))),
  },
  { key: 'lastEventAt', label: t('reports.lastEvent'), render: (r) => formatDate(r.lastEventAt) },
];

export async function render(container, { params }) {
  const result = await run(() => api.get(`/api/v1/reports/campaigns/${params.id}`));
  if (!result) return;
  const c = result.data;
  const s = c.stats;

  const recipients = dataTable({
    load: (query) => api.get(`/api/v1/reports/campaigns/${c.id}/recipients`, query),
    filters: [
      { name: 'status', label: t('users.statusLabel'), type: 'select', options: STATUS_FILTERS.map((v) => ({ value: v, label: t(`reports.statusFilter.${v}`) })) },
      { name: 'event', label: t('reports.event'), type: 'select', options: EVENT_FILTERS.map((v) => ({ value: v, label: t(`reports.eventFilter.${v}`) })) },
    ],
    columns: [{ key: 'email', label: t('reports.email') }, ...recipientColumns()],
  });

  replace(container, [
    pageHeader(c.name, [auth.hasPermission('reports.export') ? button(t('reports.export'), async () => {
      const response = await run(() => api.download(`/api/v1/reports/campaigns/${c.id}/export`));
      if (response) await saveResponse(response, `reporte-${c.name}.csv`);
    }) : null]),
    opensNote(),
    section(t('reports.summary'), definitionList([
      [t('reports.area'), c.areaName],
      [t('reports.startedAt'), formatDate(c.startedAt)],
      [t('reports.stats.recipients'), String(s.recipients)],
      [t('reports.stats.accepted'), String(s.accepted)],
      [t('reports.stats.delivered'), rate(s.delivered, s.accepted)],
      [t('reports.stats.opened'), rate(s.opened, s.delivered)],
      [t('reports.stats.clicked'), rate(s.clicked, s.delivered)],
      [t('reports.stats.hardBounces'), String(s.hardBounces)],
      [t('reports.stats.softBounces'), String(s.softBounces)],
      [t('reports.stats.complaints'), String(s.complaints)],
      [t('reports.stats.unsubscribes'), String(s.unsubscribes)],
      [t('reports.stats.rejected'), String(s.rejected)],
      [t('reports.stats.suppressed'), String(s.suppressed)],
      [t('reports.stats.pending'), String(s.pending)],
      [t('reports.stats.notSent'), String(s.notSent)],
    ])),
    section(t('campaigns.recipients'), recipients.element),
  ]);
}
