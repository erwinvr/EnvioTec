import { el } from '../core/dom.js';
import { t } from '../core/i18n.js';

export function loader() {
  return el('div', { className: 'loader', attrs: { role: 'status', 'aria-live': 'polite' }, text: t('common.loading') });
}
