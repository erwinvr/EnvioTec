import { el } from '../core/dom.js';
import { t } from '../core/i18n.js';

// Native <dialog>: focus trap, Escape and backdrop come from the browser.
// Returns { dialog, body, close }; onClose runs once when it closes.
export function openModal({ title, content, onClose, wide = false }) {
  const body = el('div', { className: 'modal-body' }, content);
  const closeButton = el('button', {
    className: 'button button-ghost modal-close', text: '×', attrs: { type: 'button', 'aria-label': t('common.close') },
  });
  const dialog = el('dialog', { className: wide ? 'modal modal-wide' : 'modal', attrs: { 'aria-labelledby': 'modal-title' } }, [
    el('header', { className: 'modal-header' }, [el('h2', { text: title, attrs: { id: 'modal-title' } }), closeButton]),
    body,
  ]);
  const close = () => dialog.close();
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, close };
}
