import { auth } from '../core/auth.js';
import { el, replace } from '../core/dom.js';
import { formatDate, t } from '../core/i18n.js';
import { badge, definitionList, pageHeader, section } from '../components/page.js';

// Account status and shortcuts by permission. Business metrics arrive with
// the business modules (phase 8).
const SHORTCUTS = [
  { path: '/usuarios', label: 'nav.users', permission: 'users.view' },
  { path: '/usuarios/revision', label: 'users.reviewTitle', permission: 'users.view' },
  { path: '/roles', label: 'nav.roles', permission: 'roles.view' },
  { path: '/auditoria', label: 'nav.audit', permission: 'audit.view' },
  { path: '/parametros', label: 'nav.settings', permission: 'settings.manage' },
];

export function render(container) {
  const user = auth.currentUser();
  const shortcuts = SHORTCUTS.filter((item) => auth.hasPermission(item.permission));
  replace(container, [
    pageHeader(t('home.welcome', { name: user.displayName })),
    section(t('home.account'), definitionList([
      [t('users.username'), user.username],
      [t('users.authSource'), t(`users.source.${user.authSource}`)],
      [t('users.mfa'), user.mfaEnabled ? badge(t('common.enabled'), 'ok') : badge(t('common.disabled'), auth.mfaRequired() ? 'warning' : '')],
      [t('home.sessionExpires'), formatDate(auth.sessionExpiresAt())],
    ])),
    shortcuts.length > 0 ? section(t('home.shortcuts'), el('ul', { className: 'shortcuts' }, shortcuts.map((item) =>
      el('li', {}, [el('a', { className: 'button', text: t(item.label), attrs: { href: `#${item.path}` } })])))) : null,
  ]);
}
