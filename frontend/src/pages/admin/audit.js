import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader } from '../../components/page.js';

const RESULTS = ['success', 'denied', 'failure'];
const toIso = (day, endOfDay) => new Date(`${day}T${endOfDay ? '23:59:59' : '00:00:00'}-04:00`).toISOString();

export function render(container) {
  const table = dataTable({
    load: (query) => api.get('/api/v1/audit-logs', query),
    filters: [
      { name: 'action', label: t('audit.action') },
      { name: 'resourceId', label: t('audit.resourceId') },
      { name: 'result', label: t('audit.result'), type: 'select', options: RESULTS.map((r) => ({ value: r, label: t(`audit.results.${r}`) })) },
    ],
    columns: [
      { key: 'occurredAt', label: t('audit.date'), render: (e) => formatDate(e.occurredAt) },
      { key: 'actor', label: t('audit.actor'), render: (e) => e.actorUsername ?? t(`audit.actorTypes.${e.actorType}`) },
      { key: 'action', label: t('audit.action'), render: (e) => el('code', { text: e.action }) },
      { key: 'resource', label: t('audit.resource'), render: (e) => (e.resourceType ? `${e.resourceType} ${e.resourceId ?? ''}` : '—') },
      { key: 'result', label: t('audit.result'), render: (e) => badge(t(`audit.results.${e.result}`), e.result === 'success' ? 'ok' : 'warning') },
      { key: 'ip', label: t('sessions.ip') },
      { key: 'metadata', label: t('audit.metadata'), render: (e) => el('code', { className: 'metadata', text: JSON.stringify(e.metadata) }) },
    ],
  });

  // CSV export (audit.export + reauthentication, at most 92 days).
  function exportCsv() {
    const today = new Date().toISOString().slice(0, 10);
    const form = createForm({
      fields: [
        { name: 'from', label: t('audit.from'), type: 'date', required: true, value: today },
        { name: 'to', label: t('audit.to'), type: 'date', required: true, value: today },
      ],
      submitLabel: t('audit.export'),
      onSubmit: async (values) => {
        const response = await run(() => api.download('/api/v1/audit-logs/export', { from: toIso(values.from, false), to: toIso(values.to, true) }), { form });
        if (!response) return;
        const url = URL.createObjectURL(await response.blob());
        const link = el('a', { attrs: { href: url, download: `auditoria-${values.from}-${values.to}.csv` } });
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        modal.close();
      },
    });
    const modal = openModal({ title: t('audit.export'), content: [el('p', { text: t('audit.exportHelp') }), form.element] });
  }

  replace(container, [
    pageHeader(t('nav.audit'), [auth.hasPermission('audit.export') ? button(t('audit.export'), exportCsv, { kind: 'primary' }) : null]),
    table.element,
  ]);
}
