import { el } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { openModal } from './modal.js';

// Resolves true if the user confirms.
export function confirmDialog({ title, message, confirmLabel = t('common.confirm'), danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const confirmButton = el('button', {
      className: danger ? 'button button-danger' : 'button button-primary', text: confirmLabel, attrs: { type: 'button' },
    });
    const cancelButton = el('button', { className: 'button', text: t('common.cancel'), attrs: { type: 'button' } });
    const modal = openModal({
      title,
      content: [el('p', { text: message }), el('div', { className: 'actions' }, [cancelButton, confirmButton])],
      onClose: () => resolve(answer),
    });
    confirmButton.addEventListener('click', () => {
      answer = true;
      modal.close();
    });
    cancelButton.addEventListener('click', () => modal.close());
  });
}
