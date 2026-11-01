import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { continueSession } from './session-flow.js';

export function render(container) {
  const form = createForm({
    fields: [
      { name: 'username', label: t('auth.username'), required: true, maxLength: 64, autocomplete: 'username' },
      { name: 'password', label: t('auth.password'), type: 'password', required: true, maxLength: 256, trim: false, autocomplete: 'current-password' },
    ],
    submitLabel: t('auth.signIn'),
    onSubmit: async (values) => {
      const result = await run(() => api.post('/api/v1/auth/login', values), { form });
      if (result) continueSession(result.data);
    },
  });
  replace(container, el('div', { className: 'auth-card card' }, [
    el('h1', { text: t('auth.signInTitle') }),
    form.element,
    el('p', {}, [el('a', { text: t('auth.forgotLink'), attrs: { href: '#/recuperar-contrasena' } })]),
  ]));
}
