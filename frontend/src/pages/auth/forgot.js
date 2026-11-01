import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';

// Same message whether or not the email belongs to an account (A5).
export function render(container) {
  const card = el('div', { className: 'auth-card card' });
  const form = createForm({
    fields: [{ name: 'email', label: t('auth.email'), type: 'email', required: true, maxLength: 254, autocomplete: 'email' }],
    submitLabel: t('auth.sendLink'),
    onSubmit: async (values) => {
      const result = await run(() => api.post('/api/v1/auth/password/forgot', values), { form });
      if (result) replace(card, [el('h1', { text: t('auth.forgotTitle') }), el('p', { text: t('auth.forgotSent') }), backToLogin()]);
    },
  });
  replace(card, [el('h1', { text: t('auth.forgotTitle') }), el('p', { text: t('auth.forgotHelp') }), form.element, backToLogin()]);
  replace(container, card);
}

export function backToLogin() {
  return el('p', {}, [el('a', { text: t('auth.backToLogin'), attrs: { href: '#/ingresar' } })]);
}
