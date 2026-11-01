import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { button, secretBox } from '../../components/page.js';
import { continueSession } from './session-flow.js';

// MFA enrollment (ADR-006). AD accounts first enter the one-time code an
// administrator gave them through another channel.
export function render(container) {
  const card = el('div', { className: 'auth-card card' });
  replace(container, card);
  const isAd = auth.currentUser()?.authSource === 'ad';

  async function start(body) {
    return run(() => api.post('/api/v1/auth/mfa/enroll/start', body), { form: startForm });
  }

  function showSecret({ secret, qrDataUri }) {
    const confirm = createForm({
      fields: [{ name: 'code', label: t('auth.totpCode'), required: true, pattern: '[0-9]{6}', inputmode: 'numeric', autocomplete: 'one-time-code' }],
      submitLabel: t('auth.activateMfa'),
      onSubmit: async (values) => {
        const result = await run(() => api.post('/api/v1/auth/mfa/enroll/confirm', values), { form: confirm });
        if (result) showRecoveryCodes(result.data);
      },
    });
    replace(card, [
      el('h1', { text: t('auth.mfaEnrollTitle') }),
      el('p', { text: t('auth.mfaEnrollScan') }),
      el('img', { className: 'qr', attrs: { src: qrDataUri, alt: t('auth.qrAlt'), width: 220, height: 220 } }),
      el('p', { text: t('auth.mfaEnrollManual') }),
      el('code', { className: 'secret', text: secret, dataset: { testid: 'totp-secret' } }),
      confirm.element,
    ]);
  }

  function showRecoveryCodes({ recoveryCodes, session }) {
    replace(card, [
      el('h1', { text: t('auth.recoveryCodesTitle') }),
      secretBox(t('auth.recoveryCodesTitle'), recoveryCodes, t('auth.recoveryCodesWarning')),
      button(t('common.continue'), () => continueSession(session), { kind: 'primary' }),
    ]);
  }

  const startForm = isAd ? createForm({
    fields: [{
      name: 'enrollmentCode', label: t('auth.enrollmentCode'), required: true,
      pattern: '[A-Za-z2-7]{4}(-?[A-Za-z2-7]{4}){3}', hint: t('auth.enrollmentCodeHint'),
    }],
    submitLabel: t('common.continue'),
    onSubmit: async (values) => {
      const result = await start(values);
      if (result) showSecret(result.data);
    },
  }) : null;

  if (isAd) {
    replace(card, [el('h1', { text: t('auth.mfaEnrollTitle') }), el('p', { text: t('auth.mfaEnrollAdHelp') }), startForm.element]);
  } else {
    replace(card, el('p', { text: t('common.loading') }));
    start({}).then((result) => {
      if (result) showSecret(result.data);
    });
  }
}
