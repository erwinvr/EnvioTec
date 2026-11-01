import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { formatDate, t } from '../../core/i18n.js';
import { dataTable } from '../../components/data-table.js';
import { button, pageHeader } from '../../components/page.js';
import { navigate } from '../../core/router.js';

// Percentage of the accepted messages, for the report columns.
export const rate = (value, base) => (base > 0 ? `${value} (${Math.round((value / base) * 100)} %)` : String(value));

// Opens depend on a tracking pixel that clients block or preload (Parte B).
export const opensNote = () => el('p', { className: 'hint', text: t('reports.opensApproximate') });

export function render(container) {
  const table = dataTable({
    load: (query) => api.get('/api/v1/reports/campaigns', query),
    filters: [
      { name: 'search', label: t('reports.searchCampaign') },
      { name: 'from', label: t('reports.from'), type: 'date' },
      { name: 'to', label: t('reports.to'), type: 'date' },
    ],
    columns: [
      { key: 'name', label: t('campaigns.name'), render: (c) => el('a', { text: c.name, attrs: { href: `#/reportes/${c.id}` } }) },
      { key: 'areaName', label: t('reports.area') },
      { key: 'startedAt', label: t('reports.startedAt'), render: (c) => formatDate(c.startedAt) },
      { key: 'accepted', label: t('reports.stats.accepted'), render: (c) => c.stats.accepted },
      { key: 'delivered', label: t('reports.stats.delivered'), render: (c) => rate(c.stats.delivered, c.stats.accepted) },
      { key: 'opened', label: t('reports.stats.opened'), render: (c) => rate(c.stats.opened, c.stats.delivered) },
      { key: 'clicked', label: t('reports.stats.clicked'), render: (c) => rate(c.stats.clicked, c.stats.delivered) },
      { key: 'hardBounces', label: t('reports.stats.hardBounces'), render: (c) => c.stats.hardBounces },
      { key: 'unsubscribes', label: t('reports.stats.unsubscribes'), render: (c) => c.stats.unsubscribes },
    ],
  });

  replace(container, [
    pageHeader(t('nav.reports'), [button(t('reports.contact'), () => navigate('/reportes/contacto'))]),
    opensNote(),
    table.element,
  ]);
}
