import { api } from '../core/api.js';
import { replace } from '../core/dom.js';
import { run } from '../core/feedback.js';
import { formatDate, t } from '../core/i18n.js';
import { dataTable } from '../components/data-table.js';
import { definitionList, pageHeader, section } from '../components/page.js';

const number = (value) => new Intl.NumberFormat().format(value);

// History of quota movements, shared with the administration page.
export function movementsTable(path) {
  return dataTable({
    load: async (query) => {
      const result = await api.get(path, query);
      return { data: result.data.movements, meta: result.meta };
    },
    columns: [
      { key: 'occurredAt', label: t('audit.date'), render: (m) => formatDate(m.occurredAt) },
      { key: 'kind', label: t('quotas.kind'), render: (m) => t(`quotas.kinds.${m.kind}`) },
      { key: 'amount', label: t('quotas.amount'), render: (m) => number(m.amount) },
      { key: 'availableAfter', label: t('quotas.available'), render: (m) => number(m.assignedAfter - m.reservedAfter - m.consumedAfter) },
      { key: 'reason', label: t('quotas.reason') },
      { key: 'actorUsername', label: t('audit.actor') },
    ],
  });
}

export async function render(container) {
  const result = await run(() => api.get('/api/v1/quotas/me', { pageSize: 1 }));
  if (!result) return;
  const { quota } = result.data;
  replace(container, [
    pageHeader(t('quotas.mineTitle')),
    section(t('quotas.balance'), [definitionList([
      [t('quotas.available'), number(quota.available)],
      [t('quotas.assigned'), number(quota.assigned)],
      [t('quotas.reserved'), number(quota.reserved)],
      [t('quotas.consumed'), number(quota.consumed)],
    ])]),
    section(t('quotas.history'), movementsTable('/api/v1/quotas/me').element),
  ]);
}
