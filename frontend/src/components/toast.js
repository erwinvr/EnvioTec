import { el } from '../core/dom.js';

// Short messages in an aria-live region (#toasts in index.html).
const DURATION_MS = 6000;

export function toast(message, kind = 'info') {
  const region = document.getElementById('toasts');
  if (!region || !message) return;
  const item = el('div', { className: `toast toast-${kind}`, text: message, attrs: { role: kind === 'error' ? 'alert' : 'status' } });
  region.append(item);
  setTimeout(() => item.remove(), DURATION_MS);
}
