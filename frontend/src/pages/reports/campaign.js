import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { dataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
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

// Opens and clicks of one recipient with time, device, system, mail client
// and (with contacts.view) IP and location, as Mandrill reports them (ADR-029).
async function showEvents(campaignId, recipient) {
  const result = await run(() => api.get(`/api/v1/reports/campaigns/${campaignId}/recipients/${recipient.id}/events`));
  if (!result) return;
  const cell = (value) => el('td', { text: value ?? '—' });
  const rows = result.data.map((e) => el('tr', {}, [
    cell(t(`reports.eventType.${e.type}`)), cell(formatDate(e.occurredAt)),
    cell(e.device ? t(`reports.device.${e.device}`) : null), cell(e.os), cell(e.client), cell(e.location), cell(e.ip), cell(e.url),
  ]));
  const headers = ['reports.event', 'audit.date', 'reports.deviceLabel', 'reports.os', 'reports.client', 'reports.location', 'reports.ip', 'reports.url'];
  openModal({
    title: t('reports.eventsOf', { email: recipient.email }), wide: true,
    content: rows.length === 0 ? el('p', { className: 'empty', text: t('reports.noEvents') }) : el('div', {}, [
      el('p', { className: 'hint', text: t('reports.eventsHint') }),
      el('table', { className: 'table' }, [el('thead', {}, [el('tr', {}, headers.map((key) => el('th', { text: t(key) })))]), el('tbody', {}, rows)]),
    ]),
  });
}

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
    columns: [
      { key: 'email', label: t('reports.email') },
      ...(c.byDay ? [{ key: 'sendAt', label: t('campaigns.sendAt'), render: (r) => formatDate(r.sendAt) }] : []),
      ...recipientColumns(),
      { key: 'events', label: '', render: (r) => button(t('reports.details'), () => showEvents(c.id, r)) },
    ],
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
    // Sending by each contact's date (ADR-030): figures per scheduled day.
    c.byDay ? section(t('reports.byDay'), el('table', { className: 'table' }, [
      el('thead', {}, [el('tr', {}, ['reports.day', 'reports.stats.recipients', 'reports.stats.accepted', 'reports.stats.pending', 'reports.stats.delivered',
        'reports.stats.opened', 'reports.stats.clicked'].map((key) => el('th', { text: t(key) })))]),
      el('tbody', {}, c.byDay.map((d) => el('tr', {}, [d.day ? d.day.split('-').reverse().join('/') : '—', d.recipients, d.accepted, d.pending,
        d.delivered, d.opened, d.clicked].map((value) => el('td', { text: String(value) }))))),
    ])) : null,
    section(t('campaigns.recipients'), recipients.element),
  ]);
}
