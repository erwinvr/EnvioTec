import { el, svg } from '../core/dom.js';

// Charts drawn as SVG with DOM APIs (A9): no library, no HTML strings and no
// inline styles (colors come from CSS classes). Each chart carries a text
// alternative: an accessible name and its data as a table.

const SERIES_COUNT = 5;
const seriesClass = (index) => `series-${(index % SERIES_COUNT) + 1}`;
const swatchClass = (index) => `swatch swatch-${(index % SERIES_COUNT) + 1}`;

// Upper bound of the Y axis: 1, 2, 2.5 or 5 times a power of ten, at least 1.
export function niceMax(values) {
  const max = Math.max(1, ...values.filter(Number.isFinite));
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((factor) => factor * power >= max);
  return step * power;
}

// Indexes of the X labels to show: at most `count`, always the first and last.
export function labelIndexes(length, count = 7) {
  if (length <= count) return [...Array(length).keys()];
  const step = (length - 1) / (count - 1);
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * step)))];
}

// Bar height as one of 11 CSS classes (0 to 10): no inline styles.
export function barLevel(value, max) {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(1, Math.round((value / max) * 10));
}

// Smooth SVG path through the points (monotone cubic, Fritsch-Carlson):
// the curve never rises above or dips below its neighbouring values, so it
// never shows a figure that does not exist (for example, below zero).
export function smoothPath(points) {
  if (points.length === 0) return '';
  const fmt = (n) => Number(n.toFixed(1));
  if (points.length < 3) return points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${fmt(px)},${fmt(py)}`).join(' ');
  const n = points.length;
  const slopes = points.slice(0, -1).map(([x0, y0], i) => (points[i + 1][1] - y0) / (points[i + 1][0] - x0));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === n - 1) return slopes[n - 2];
    return slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  });
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      tangents[i] = (3 * a * slopes[i]) / h;
      tangents[i + 1] = (3 * b * slopes[i]) / h;
    }
  }
  let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const dx = (x1 - x0) / 3;
    d += ` C${fmt(x0 + dx)},${fmt(y0 + tangents[i] * dx)} ${fmt(x1 - dx)},${fmt(y1 - tangents[i + 1] * dx)} ${fmt(x1)},${fmt(y1)}`;
  }
  return d;
}

// Start and length of each slice, as fractions of the whole.
export function donutSegments(values) {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  let start = 0;
  return values.map((value) => {
    const fraction = total > 0 ? Math.max(0, value) / total : 0;
    const segment = { start, fraction };
    start += fraction;
    return segment;
  });
}

function dataTable(caption, headers, rows) {
  return el('details', { className: 'chart-data' }, [
    el('summary', { text: caption }),
    el('div', { className: 'chart-table' }, [
      el('table', { className: 'table' }, [
        el('thead', {}, [el('tr', {}, headers.map((header) => el('th', { text: header, attrs: { scope: 'col' } })))]),
        el('tbody', {}, rows.map((row) => el('tr', {}, row.map((cell) => el('td', { text: cell }))))),
      ]),
    ]),
  ]);
}

function legend(names) {
  return el('ul', { className: 'legend' }, names.map((name, index) => el('li', {}, [
    el('span', { className: swatchClass(index), attrs: { 'aria-hidden': 'true' } }), name,
  ])));
}

// Lines over the same X labels. series: [{ name, values }].
export function lineChart({ title, labels, series, dataCaption, format = String }) {
  const width = 640;
  const height = 260;
  const pad = { top: 12, right: 12, bottom: 30, left: 44 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const max = niceMax(series.flatMap((s) => s.values));
  const x = (i) => pad.left + (labels.length > 1 ? (i / (labels.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value) => pad.top + plotHeight - (value / max) * plotHeight;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((step) => {
    const value = max * step;
    return [
      svg('line', { class: 'grid', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) }),
      svg('text', { x: pad.left - 8, y: y(value) + 4, 'text-anchor': 'end' }, [format(value)]),
    ];
  });
  const xLabels = labelIndexes(labels.length).map((i) => svg('text', { x: x(i), y: height - 8, 'text-anchor': 'middle' }, [labels[i]]));
  const lines = series.map((s, index) => {
    const d = smoothPath(s.values.map((value, i) => [x(i), y(value)]));
    const dots = labels.length <= 31 ? s.values.map((value, i) => svg('circle', { class: `dot ${seriesClass(index)}`, cx: x(i), cy: y(value), r: 3.5 }, [
      svg('title', {}, [`${s.name} · ${labels[i]}: ${format(value)}`]),
    ])) : [];
    return svg('g', {}, [svg('path', { class: `line ${seriesClass(index)}`, d }), ...dots]);
  });

  return el('figure', { className: 'chart-figure' }, [
    svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title }, [...grid, ...xLabels, ...lines]),
    legend(series.map((s) => s.name)),
    dataTable(dataCaption, ['', ...series.map((s) => s.name)], labels.map((label, i) => [label, ...series.map((s) => format(s.values[i]))])),
  ]);
}

// Donut with the total in the middle. items: [{ label, value }].
export function donutChart({ title, items, totalLabel, dataCaption, format = String }) {
  const size = 220;
  const radius = 80;
  const stroke = 30;
  const circumference = 2 * Math.PI * radius;
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const segments = donutSegments(items.map((item) => item.value));
  const percent = (fraction) => `${Math.round(fraction * 100)} %`;

  const slices = items.map((item, index) => {
    const { start, fraction } = segments[index];
    if (fraction === 0) return null;
    return svg('circle', {
      class: `slice ${seriesClass(index)}`, cx: size / 2, cy: size / 2, r: radius, 'stroke-width': stroke,
      'stroke-dasharray': `${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
      'stroke-dashoffset': (-start * circumference).toFixed(2),
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }, [svg('title', {}, [`${item.label}: ${format(item.value)} (${percent(fraction)})`])]);
  });

  return el('figure', { className: 'chart-figure' }, [
    svg('svg', { class: 'chart', viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': title }, [
      svg('circle', { class: 'slice series-5', cx: size / 2, cy: size / 2, r: radius, 'stroke-width': stroke }),
      ...slices,
      svg('text', { class: 'donut-total', x: size / 2, y: size / 2 + 4, 'text-anchor': 'middle' }, [format(total)]),
      svg('text', { class: 'donut-caption', x: size / 2, y: size / 2 + 22, 'text-anchor': 'middle' }, [totalLabel]),
    ]),
    legend(items.map((item) => `${item.label} · ${percent(segments[items.indexOf(item)].fraction)}`)),
    dataTable(dataCaption, ['', title], items.map((item) => [item.label, format(item.value)])),
  ]);
}

// Sums consecutive values into at most `count` buckets, in order.
export function buckets(values, count = 12) {
  if (values.length <= count) return [...values];
  const size = Math.ceil(values.length / count);
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size).reduce((sum, value) => sum + value, 0));
  return result;
}

// Small decorative bars for a KPI card (the figures are in the card's text).
export function miniBars(values) {
  const grouped = buckets(values);
  const max = Math.max(0, ...grouped);
  return el('div', { className: 'bars', attrs: { 'aria-hidden': 'true' } },
    grouped.map((value) => el('span', { className: `bar bar-h-${barLevel(value, max)}` })));
}
