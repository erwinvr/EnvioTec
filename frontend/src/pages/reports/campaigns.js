import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, language, t } from '../../core/i18n.js';
import { navigate } from '../../core/router.js';
import { donutChart, lineChart, miniBars } from '../../components/charts.js';
import { dataTable } from '../../components/data-table.js';
import { button, pageHeader } from '../../components/page.js';
import { isValidPeriod, lastDays, periodFrom } from './period.js';

// Reports dashboard (ADR-031): figures of the campaigns that started in the
// period, daily activity, opens by device and the campaigns themselves.

// Percentage of the accepted messages, for the report columns.
export const rate = (value, base) => (base > 0 ? `${value} (${Math.round((value / base) * 100)} %)` : String(value));

// Opens depend on a tracking pixel that clients block or preload (Parte B).
export const opensNote = () => el('p', { className: 'hint', text: t('reports.opensApproximate') });

const locale = () => (language() === 'en' ? 'en-US' : 'es-BO');
const number = (value) => new Intl.NumberFormat(locale()).format(value);
export const percent = (value, base) => (base > 0
  ? new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 1 }).format(value / base)
  : '—');
const dayLabel = (day) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));

// Each card: its figure, the base it is measured against and, when there is
// a daily series for it, small bars of that series.
const KPIS = [
  { key: 'delivered', base: 'accepted', series: 'sent', featured: true },
  { key: 'opened', base: 'delivered', series: 'opened' },
  { key: 'clicked', base: 'delivered', series: 'clicked' },
  { key: 'hardBounces', base: 'accepted' },
  { key: 'unsubscribes', base: 'delivered' },
  { key: 'complaints', base: 'delivered' },
];
const DEVICES = ['mobile', 'desktop', 'tablet', 'proxy', 'unknown'];
const PRESETS = [7, 30, 90];

function kpiCard({ key, base, series, featured }, stats, daily) {
  return el('section', { className: `card kpi${featured ? ' kpi-featured' : ''}` }, [
    el('h2', { className: 'kpi-label', text: t(`reports.kpi.${key}`) }),
    el('p', { className: 'kpi-value', text: percent(stats[key], stats[base]) }),
    el('p', { className: 'kpi-detail', text: t(`reports.kpiDetail.${key}`, { count: number(stats[key]), base: number(stats[base]) }) }),
    series ? miniBars(daily.map((day) => day[series])) : null,
  ]);
}

function periodForm({ from, to }) {
  const go = (period) => navigate(`/reportes?desde=${period.from}&hasta=${period.to}`);
  return el('form', {
    className: 'card period',
    on: {
      submit: (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const period = { from: data.get('desde'), to: data.get('hasta') };
        if (!isValidPeriod(period.from, period.to)) {
          event.currentTarget.querySelector('.form-error').textContent = t('validation.invalid_period');
          return;
        }
        go(period);
      },
    },
  }, [
    el('label', { className: 'filter' }, [el('span', { text: t('reports.from') }), el('input', { attrs: { type: 'date', name: 'desde', required: true }, value: from })]),
    el('label', { className: 'filter' }, [el('span', { text: t('reports.to') }), el('input', { attrs: { type: 'date', name: 'hasta', required: true }, value: to })]),
    el('button', { className: 'button button-primary', text: t('reports.apply'), attrs: { type: 'submit' } }),
    el('div', { className: 'actions' }, PRESETS.map((days) => button(t('reports.lastDays', { days }), () => go(lastDays(days)), { kind: 'soft' }))),
    el('p', { className: 'form-error', attrs: { role: 'alert' } }),
  ]);
}

function charts(overview) {
  const labels = overview.daily.map((day) => dayLabel(day.day));
  const activity = lineChart({
    title: t('reports.dailyActivity'), labels, dataCaption: t('reports.showData'), format: (value) => number(Math.round(value)),
    series: ['sent', 'opened', 'clicked'].map((key) => ({ name: t(`reports.series.${key}`), values: overview.daily.map((day) => day[key]) })),
  });
  const byDevice = new Map(overview.devices.map((d) => [d.device, d.recipients]));
  const items = DEVICES.filter((device) => byDevice.has(device)).map((device) => ({ label: t(`reports.device.${device}`), value: byDevice.get(device) }));
  const devices = items.length === 0
    ? el('p', { className: 'empty', text: t('reports.noOpens') })
    : donutChart({ title: t('reports.devices'), items, totalLabel: t('reports.devicesTotal'), dataCaption: t('reports.showData'), format: number });
  return el('div', { className: 'dashboard-grid' }, [
    el('section', { className: 'card' }, [el('div', { className: 'chart-header' }, [el('h2', { text: t('reports.dailyActivity') })]), activity]),
    el('section', { className: 'card donut' }, [
      el('div', { className: 'chart-header' }, [el('h2', { text: t('reports.devices') })]), devices,
      el('p', { className: 'hint', text: t('reports.devicesHint') }),
    ]),
  ]);
}

export async function render(container, { query } = {}) {
  const period = periodFrom(query);
  const result = await run(() => api.get('/api/v1/reports/overview', period));
  if (!result) return;
  const overview = result.data;

  const table = dataTable({
    load: (params) => api.get('/api/v1/reports/campaigns', { ...params, from: period.from, to: period.to }),
    filters: [{ name: 'search', label: t('reports.searchCampaign') }],
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
    periodForm(period),
    el('p', { className: 'hint', text: t('reports.campaignsInPeriod', { count: number(overview.campaigns) }) }),
    el('div', { className: 'kpis' }, KPIS.map((kpi) => kpiCard(kpi, overview.stats, overview.daily))),
    el('p', { className: 'hint', text: t('reports.ratesHint') }),
    opensNote(),
    charts(overview),
    el('section', { className: 'card' }, [el('h2', { text: t('reports.campaignsTitle') }), table.element]),
  ]);
}
