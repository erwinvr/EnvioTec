import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { backToLogin } from './forgot.js';
import { passwordFields, samePasswords } from './password-fields.js';

export function render(container, { query }) {
  const card = el('div', { className: 'auth-card card' });
  replace(container, card);
  const token = query.token ?? '';
  // The token leaves the address bar and the history right away.
  window.history.replaceState(null, '', '#/restablecer-contrasena');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    replace(card, [el('h1', { text: t('auth.resetTitle') }), el('p', { text: t('auth.resetInvalid') }), backToLogin()]);
    return;
  }
  const form = createForm({
    fields: passwordFields(),
    submitLabel: t('auth.changePassword'),
    onSubmit: async (values) => {
      if (!samePasswords(values, form)) return;
      const result = await run(() => api.post('/api/v1/auth/password/reset', { token, newPassword: values.newPassword }), { form });
      if (result) replace(card, [el('h1', { text: t('auth.resetTitle') }), el('p', { text: t('auth.resetDone') }), backToLogin()]);
    },
  });
  replace(card, [el('h1', { text: t('auth.resetTitle') }), el('p', { className: 'hint', text: t('auth.passwordPolicy') }), form.element]);
}
