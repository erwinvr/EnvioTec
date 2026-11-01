import { api } from '../core/api.js';
import { auth } from '../core/auth.js';
import { describeError } from '../core/errors.js';
import { el } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { createForm } from './form.js';
import { openModal } from './modal.js';

// Asks for the password (or a TOTP code when MFA is configured) before a
// sensitive action (A5). Resolves true once the backend accepted it.
export function askReauth() {
  return new Promise((resolve) => {
    let accepted = false;
    const withMfa = auth.currentUser()?.mfaEnabled === true;
    const form = createForm({
      fields: [withMfa
        ? { name: 'code', label: t('auth.totpCode'), required: true, pattern: '[0-9]{6}', inputmode: 'numeric', autocomplete: 'one-time-code' }
        : { name: 'password', label: t('auth.password'), type: 'password', required: true, maxLength: 256, trim: false, autocomplete: 'current-password' }],
      submitLabel: t('auth.confirmIdentity'),
      onSubmit: async (values, f) => {
        try {
          await api.post('/api/v1/auth/reauth', values);
          accepted = true;
          modal.close();
        } catch (error) {
          const outcome = describeError(error);
          f.showErrors(outcome.fields ?? {}, outcome.message ?? t('errors.validation'));
        }
      },
    });
    const modal = openModal({
      title: t('auth.reauthTitle'),
      content: [el('p', { text: t('auth.reauthHelp') }), form.element],
      onClose: () => resolve(accepted),
    });
  });
}
