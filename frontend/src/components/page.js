import { el } from '../core/dom.js';

// Common page building blocks.
export function pageHeader(title, actions = []) {
  return el('header', { className: 'page-header' }, [el('h1', { text: title }), el('div', { className: 'actions' }, actions)]);
}

export function section(title, children) {
  return el('section', { className: 'card' }, [title ? el('h2', { text: title }) : null, ...[children].flat()]);
}

export function button(label, onClick, { kind = '', type = 'button' } = {}) {
  return el('button', { className: `button ${kind ? `button-${kind}` : ''}`.trim(), text: label, attrs: { type }, on: { click: onClick } });
}

export function badge(text, kind = '') {
  return el('span', { className: `badge ${kind ? `badge-${kind}` : ''}`.trim(), text });
}

export function definitionList(entries) {
  return el('dl', { className: 'details' }, entries.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', {}, [value ?? '—'])]));
}

// Shows a secret (temporary password, enrollment code, recovery codes) once,
// with a warning that it will not be shown again.
export function secretBox(label, values, warning) {
  return el('div', { className: 'secret-box', attrs: { role: 'region', 'aria-label': label } }, [
    el('p', { className: 'warning', text: warning }),
    el('ul', { className: 'secret-values' }, [values].flat().map((value) => el('li', {}, [el('code', { text: value, dataset: { secret: '' } })]))),
  ]);
}
