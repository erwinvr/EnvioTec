import { request } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { formatDate, t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { dataTable } from '../../components/data-table.js';
import { pageHeader, section } from '../../components/page.js';
import { recipientColumns } from './campaign.js';
import { opensNote } from './campaigns.js';

// Everything sent to one address within the user's areas. The address goes
// in the body of a POST, never in the URL (ADR-025); the lookup is audited.
export function render(container) {
  const results = el('div');
  const form = createForm({
    fields: [{ name: 'email', label: t('reports.email'), type: 'email', required: true, maxLength: 254 }],
    submitLabel: t('common.search'),
    onSubmit: async ({ email }) => {
      const table = dataTable({
        load: (query) => request('POST', '/api/v1/reports/contacts/search', { body: { email }, query }),
        columns: [
          { key: 'campaignName', label: t('campaigns.name'), render: (r) => el('a', { text: r.campaignName, attrs: { href: `#/reportes/${r.campaignId}` } }) },
          { key: 'areaName', label: t('reports.area') },
          { key: 'startedAt', label: t('reports.startedAt'), render: (r) => formatDate(r.startedAt) },
          ...recipientColumns(),
        ],
      });
      replace(results, section(t('reports.history'), table.element));
    },
  });

  replace(container, [
    pageHeader(t('reports.contact')),
    el('p', { className: 'hint', text: t('reports.contactHint') }),
    opensNote(),
    form.element,
    results,
  ]);
}
