import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { continueSession } from './session-flow.js';

export function render(container) {
  let useRecovery = false;
  const slot = el('div');
  const toggle = el('button', { className: 'button button-ghost', attrs: { type: 'button' } });

  function draw() {
    const field = useRecovery
      ? { name: 'recoveryCode', label: t('auth.recoveryCode'), required: true, pattern: '[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}', autocomplete: 'off' }
      : { name: 'code', label: t('auth.totpCode'), required: true, pattern: '[0-9]{6}', inputmode: 'numeric', autocomplete: 'one-time-code' };
    const form = createForm({
      fields: [field],
      submitLabel: t('auth.verify'),
      onSubmit: async (values) => {
        const result = await run(() => api.post('/api/v1/auth/mfa/verify', values), { form });
        if (result) continueSession(result.data);
      },
    });
    toggle.textContent = useRecovery ? t('auth.useTotp') : t('auth.useRecovery');
    replace(slot, form.element);
    form.element.querySelector('input')?.focus();
  }
  toggle.addEventListener('click', () => { useRecovery = !useRecovery; draw(); });
  draw();
  replace(container, el('div', { className: 'auth-card card' }, [
    el('h1', { text: t('auth.mfaVerifyTitle') }), el('p', { text: t('auth.mfaVerifyHelp') }), slot, toggle,
  ]));
}
