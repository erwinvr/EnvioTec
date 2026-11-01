import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { toast } from '../../components/toast.js';
import { createForm } from '../../components/form.js';
import { passwordFields, samePasswords } from './password-fields.js';
import { continueSession } from './session-flow.js';

export function render(container) {
  if (auth.currentUser()?.authSource === 'ad') {
    replace(container, el('div', { className: 'card' }, [el('p', { text: t('auth.adPasswordHelp') })]));
    return;
  }
  const forced = auth.stage() === 'password_change';
  const form = createForm({
    fields: [
      { name: 'currentPassword', label: forced ? t('auth.temporaryPassword') : t('auth.currentPassword'), type: 'password', required: true, maxLength: 256, trim: false, autocomplete: 'current-password' },
      ...passwordFields(),
    ],
    submitLabel: t('auth.changePassword'),
    onSubmit: async (values) => {
      if (!samePasswords(values, form)) return;
      const result = await run(() => api.post('/api/v1/auth/password/change', {
        currentPassword: values.currentPassword, newPassword: values.newPassword,
      }), { form });
      if (!result) return;
      toast(t('auth.passwordChanged'), 'success');
      continueSession(result.data);
    },
  });
  replace(container, el('div', { className: 'auth-card card' }, [
    el('h1', { text: t('auth.changePasswordTitle') }),
    forced ? el('p', { text: t('auth.mustChangePassword') }) : null,
    el('p', { className: 'hint', text: t('auth.passwordPolicy') }),
    form.element,
  ]));
}
