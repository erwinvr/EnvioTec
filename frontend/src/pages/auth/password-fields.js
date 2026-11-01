import { t } from '../../core/i18n.js';

// New password + confirmation, with the policy limits (12 to 128; the
// backend also rejects common passwords).
export function passwordFields() {
  return [
    { name: 'newPassword', label: t('auth.newPassword'), type: 'password', required: true, minLength: 12, maxLength: 128, trim: false, autocomplete: 'new-password' },
    { name: 'confirmPassword', label: t('auth.confirmPassword'), type: 'password', required: true, maxLength: 128, trim: false, autocomplete: 'new-password' },
  ];
}

export function samePasswords(values, form) {
  if (values.newPassword === values.confirmPassword) return true;
  form.showErrors({ confirmPassword: t('validation.passwords_differ') }, t('errors.validation'));
  return false;
}
