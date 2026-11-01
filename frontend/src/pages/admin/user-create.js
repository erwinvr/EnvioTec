import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { button, pageHeader, secretBox, section } from '../../components/page.js';
import { navigate } from '../../core/router.js';
import { areas, optionsOf } from './lookups.js';

// Local account (Parte B): area required; the server generates the
// temporary password and it is shown only once.
export async function render(container) {
  const areaList = (await run(areas)) ?? [];
  const slot = el('div');
  const form = createForm({
    fields: [
      { name: 'username', label: t('users.username'), required: true, pattern: '[A-Za-z0-9._-]{3,64}', hint: t('users.usernameHint') },
      { name: 'email', label: t('users.email'), type: 'email', required: true, maxLength: 254 },
      { name: 'displayName', label: t('users.displayName'), required: true, maxLength: 200 },
      { name: 'areaId', label: t('users.area'), type: 'select', required: true, options: [{ value: '', label: '—' }, ...optionsOf(areaList.filter((a) => a.isActive))] },
      { name: 'expiresOn', label: t('users.expiresAt'), type: 'date', hint: t('users.expiresHint') },
    ],
    submitLabel: t('users.create'),
    onSubmit: async ({ expiresOn, ...values }) => {
      const body = { ...values };
      if (expiresOn) body.expiresAt = new Date(`${expiresOn}T23:59:59-04:00`).toISOString();
      const result = await run(() => api.post('/api/v1/users', body), { form });
      if (!result) return;
      const { user, temporaryPassword } = result.data;
      replace(slot, section(t('users.createdTitle', { name: user.username }), [
        secretBox(t('users.temporaryPassword'), temporaryPassword, t('users.temporaryPasswordWarning')),
        el('div', { className: 'actions' }, [button(t('users.openUser'), () => navigate(`/usuarios/${user.id}`), { kind: 'primary' })]),
      ]));
    },
  });
  replace(slot, section(null, form.element));
  replace(container, [pageHeader(t('users.create')), slot]);
}
