import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { button, definitionList, pageHeader, section } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { movementsTable } from '../my-quota.js';

const number = (value) => new Intl.NumberFormat().format(value);

// Quotas of every user in scope, the global monthly usage and adjustments
// (quotas.manage: reason and reauthentication; never one's own).
export async function render(container) {
  const usage = await run(() => api.get('/api/v1/quotas/global'));
  const table = dataTable({
    rowKey: 'userId',
    load: (query) => api.get('/api/v1/quotas', query),
    filters: [{ name: 'search', label: t('common.search') }],
    columns: [
      { key: 'username', label: t('users.username') },
      { key: 'displayName', label: t('users.displayName') },
      { key: 'areaName', label: t('users.area') },
      { key: 'assigned', label: t('quotas.assigned'), render: (q) => number(q.assigned) },
      { key: 'reserved', label: t('quotas.reserved'), render: (q) => number(q.reserved) },
      { key: 'consumed', label: t('quotas.consumed'), render: (q) => number(q.consumed) },
      { key: 'available', label: t('quotas.available'), render: (q) => number(q.available) },
      {
        key: 'actions', label: '', render: (q) => el('span', { className: 'actions' }, [
          button(t('quotas.history'), () => history(q)),
          auth.hasPermission('quotas.manage') && q.userId !== auth.currentUser().id ? button(t('quotas.adjust'), () => adjust(q)) : null,
        ]),
      },
    ],
  });

  function history(row) {
    openModal({ title: t('quotas.historyOf', { name: row.username }), wide: true, content: movementsTable(`/api/v1/quotas/${row.userId}/movements`).element });
  }

  function adjust(row) {
    const form = createForm({
      fields: [
        { name: 'delta', label: t('quotas.delta'), type: 'number', required: true, min: -10000000, max: 10000000, hint: t('quotas.deltaHint') },
        { name: 'reason', label: t('quotas.reason'), type: 'textarea', required: true, minLength: 10, maxLength: 500 },
      ],
      submitLabel: t('quotas.adjust'),
      onSubmit: async (values) => {
        if (await run(() => api.post(`/api/v1/quotas/${row.userId}/adjust`, values), { form })) {
          toast(t('quotas.adjusted'), 'success');
          modal.close();
          table.refresh();
        }
      },
    });
    const modal = openModal({ title: t('quotas.adjustFor', { name: row.username }), content: form.element });
  }

  replace(container, [
    pageHeader(t('nav.quotas')),
    usage ? section(t('quotas.globalTitle', { month: usage.data.month }), definitionList([
      [t('quotas.globalSent'), number(usage.data.sent)],
      [t('quotas.globalCap'), number(usage.data.cap)],
      [t('quotas.globalRemaining'), number(usage.data.remaining)],
    ])) : null,
    table.element,
  ]);
}
