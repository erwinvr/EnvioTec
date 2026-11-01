import { api } from '../core/api.js';
import { auth } from '../core/auth.js';
import { el, replace } from '../core/dom.js';
import { run } from '../core/feedback.js';
import { formatDate, t } from '../core/i18n.js';
import { navigate } from '../core/router.js';
import { confirmDialog } from '../components/confirm-dialog.js';
import { dataTable } from '../components/data-table.js';
import { button, pageHeader, section } from '../components/page.js';
import { toast } from '../components/toast.js';

export function render(container) {
  const user = auth.currentUser();
  const sessions = dataTable({
    rowKey: 'id',
    load: () => api.get('/api/v1/auth/sessions'),
    columns: [
      { key: 'createdAt', label: t('sessions.createdAt'), render: (s) => formatDate(s.createdAt) },
      { key: 'lastSeenAt', label: t('sessions.lastSeenAt'), render: (s) => formatDate(s.lastSeenAt) },
      { key: 'ip', label: t('sessions.ip') },
      { key: 'userAgent', label: t('sessions.userAgent') },
      {
        key: 'actions', label: '', render: (s) => (s.current ? t('sessions.current') : button(t('sessions.close'), async () => {
          if (!await confirmDialog({ title: t('sessions.close'), message: t('sessions.closeConfirm') })) return;
          if (await run(() => api.delete(`/api/v1/auth/sessions/${s.id}`))) {
            toast(t('sessions.closed'), 'success');
            sessions.refresh();
          }
        })),
      },
    ],
  });
  replace(container, [
    pageHeader(t('account.title')),
    section(t('account.security'), el('div', { className: 'actions' }, [
      user.authSource === 'local' ? button(t('auth.changePassword'), () => navigate('/cambiar-contrasena')) : el('p', { text: t('auth.adPasswordHelp') }),
      user.mfaEnabled ? el('p', { text: t('account.mfaEnabled') }) : button(t('account.setupMfa'), () => navigate('/mfa/configurar')),
    ])),
    section(t('sessions.title'), sessions.element),
  ]);
}
