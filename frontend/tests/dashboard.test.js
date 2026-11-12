import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { barLevel, buckets, donutSegments, labelIndexes, niceMax, smoothPath } from '../src/components/charts.js';
import { initials, isCurrent, visibleGroups } from '../src/components/navigation.js';
import { setLanguage } from '../src/core/i18n.js';
import { addDays, isValidPeriod, lastDays, periodDays, periodFrom, todayInLaPaz } from '../src/pages/reports/period.js';
import { percent } from '../src/pages/reports/campaigns.js';

setLanguage('es');

describe('gráficos (ADR-031): geometría sin estilos en línea', () => {
  it('el eje Y termina en un valor redondo, nunca en cero', () => {
    assert.equal(niceMax([]), 1);
    assert.equal(niceMax([0, 0]), 1);
    assert.equal(niceMax([7]), 10);
    assert.equal(niceMax([180]), 200);
    assert.equal(niceMax([230]), 250);
    assert.equal(niceMax([3100]), 5000);
  });

  it('muestra como máximo 7 etiquetas en X, incluidas la primera y la última', () => {
    assert.deepEqual(labelIndexes(5), [0, 1, 2, 3, 4]);
    const many = labelIndexes(30);
    assert.ok(many.length <= 7);
    assert.deepEqual([many[0], many.at(-1)], [0, 29]);
  });

  it('las barras usan 11 niveles de clase y las series largas se agrupan', () => {
    assert.equal(barLevel(0, 10), 0);
    assert.equal(barLevel(10, 0), 0);
    assert.equal(barLevel(1, 100), 1);
    assert.equal(barLevel(55, 100), 6);
    assert.equal(barLevel(100, 100), 10);
    assert.deepEqual(buckets([1, 2, 3]), [1, 2, 3]);
    const year = buckets(Array(366).fill(1));
    assert.ok(year.length <= 12);
    assert.equal(year.reduce((a, b) => a + b, 0), 366);
  });

  it('la curva suavizada no sale del rango de los datos (no inventa valores bajo cero)', () => {
    assert.equal(smoothPath([]), '');
    assert.equal(smoothPath([[0, 10], [10, 20]]), 'M0,10 L10,20');
    const d = smoothPath([[0, 100], [10, 0], [20, 0], [30, 100], [40, 50]]);
    const ys = [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 100, d);
    assert.ok(d.startsWith('M0,100 C'));
  });

  it('la dona reparte el total y tolera ceros', () => {
    assert.deepEqual(donutSegments([1, 3]), [{ start: 0, fraction: 0.25 }, { start: 0.25, fraction: 0.75 }]);
    assert.deepEqual(donutSegments([0, 0]), [{ start: 0, fraction: 0 }, { start: 0, fraction: 0 }]);
  });

  it('los porcentajes no dividen por cero', () => {
    assert.equal(percent(1, 0), '—');
    assert.match(percent(7, 10), /^70\s?%$/);
  });
});

describe('período de los reportes (America/La_Paz)', () => {
  // 2026-11-12 02:00 UTC = 2026-11-11 22:00 en La Paz (UTC-4).
  const now = new Date('2026-11-12T02:00:00Z');

  it('el día de hoy es el de La Paz, no el de UTC', () => {
    assert.equal(todayInLaPaz(now), '2026-11-11');
  });

  it('sin período válido en la URL usa los últimos 30 días', () => {
    assert.deepEqual(periodFrom({}, now), { from: '2026-10-13', to: '2026-11-11' });
    assert.deepEqual(periodFrom({ desde: '2026-11-10', hasta: '2026-11-01' }, now), { from: '2026-10-13', to: '2026-11-11' });
    assert.deepEqual(periodFrom({ desde: '2026-01-01', hasta: '2026-01-31' }, now), { from: '2026-01-01', to: '2026-01-31' });
    assert.deepEqual(lastDays(7, now), { from: '2026-11-05', to: '2026-11-11' });
  });

  it('acepta de 1 a 366 días y rechaza fechas mal formadas', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(periodDays('2026-01-01', '2026-01-01'), 1);
    assert.equal(isValidPeriod('2026-01-01', '2027-01-01'), true);
    assert.equal(isValidPeriod('2026-01-01', '2027-01-02'), false);
    assert.equal(isValidPeriod('2026-01-02', '2026-01-01'), false);
    assert.equal(isValidPeriod("2026-01-01'", '2026-01-02'), false);
    assert.equal(isValidPeriod(undefined, '2026-01-02'), false);
  });
});

describe('menú lateral (solo experiencia de usuario; el backend decide)', () => {
  it('muestra cada grupo solo si tiene entradas permitidas', () => {
    const operator = visibleGroups((permission) => ['campaigns.view', 'reports.view'].includes(permission));
    assert.deepEqual(operator.map((group) => group.label), [null, 'nav.groupSending', 'nav.groupResults']);
    assert.deepEqual(operator[1].items.map((item) => item.path), ['/campanias']);
    assert.deepEqual(visibleGroups(() => false).map((group) => group.items.map((item) => item.path)), [['/']]);
  });

  it('marca la página actual también en sus subpáginas, sin confundir prefijos', () => {
    assert.equal(isCurrent('/', '/'), true);
    assert.equal(isCurrent('/', '/usuarios'), false);
    assert.equal(isCurrent('/reportes', '/reportes/contacto'), true);
    assert.equal(isCurrent('/usuarios', '/usuarios-otros'), false);
  });

  it('las iniciales salen del nombre visible', () => {
    assert.equal(initials('Erwin Villazón Rojas'), 'EV');
    assert.equal(initials('admin'), 'A');
    assert.equal(initials('  '), '?');
  });
});
