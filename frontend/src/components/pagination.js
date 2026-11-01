import { el } from '../core/dom.js';
import { t } from '../core/i18n.js';

export function pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return el('nav', { className: 'pagination', attrs: { 'aria-label': t('common.pagination') } }, [
    el('button', { className: 'button', text: t('common.previous'), disabled: page <= 1, attrs: { type: 'button' }, on: { click: () => onChange(page - 1) } }),
    el('span', { text: t('common.pageOf', { page, pages, total }) }),
    el('button', { className: 'button', text: t('common.next'), disabled: page >= pages, attrs: { type: 'button' }, on: { click: () => onChange(page + 1) } }),
  ]);
}
