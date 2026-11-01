import { auth, logout } from '../core/auth.js';
import { el } from '../core/dom.js';
import { language, LANGUAGES, setLanguage, t } from '../core/i18n.js';
import { navigate } from '../core/router.js';

// Menu entries are shown according to permissions (UX only, A6).
const ITEMS = [
  { path: '/', label: 'nav.home' },
  { path: '/campanias', label: 'nav.campaigns', permission: 'campaigns.view' },
  { path: '/plantillas', label: 'nav.templates', permission: 'templates.view' },
  { path: '/contactos', label: 'nav.contacts', permission: 'contacts.view' },
  { path: '/supresion', label: 'nav.suppressions', permission: 'suppressions.view' },
  { path: '/mis-envios', label: 'nav.myQuota', permission: 'quotas.view' },
  { path: '/usuarios', label: 'nav.users', permission: 'users.view' },
  { path: '/roles', label: 'nav.roles', permission: 'roles.view' },
  { path: '/areas', label: 'nav.areas', permission: 'areas.manage' },
  { path: '/directorio', label: 'nav.directory', permission: 'directory.manage' },
  { path: '/remitentes', label: 'nav.senders', permission: 'senders.manage' },
  { path: '/cuotas', label: 'nav.quotas', permission: 'quotas.manage' },
  { path: '/parametros', label: 'nav.settings', permission: 'settings.manage' },
  { path: '/auditoria', label: 'nav.audit', permission: 'audit.view' },
];

export function renderNavigation(container, currentPath, onLanguageChange) {
  const user = auth.currentUser();
  const full = auth.stage() === 'full';
  const links = full ? ITEMS.filter((item) => !item.permission || auth.hasPermission(item.permission)) : [];
  const languageSelect = el('select', {
    className: 'language', attrs: { 'aria-label': t('nav.language') },
    on: { change: (event) => { setLanguage(event.target.value, { persist: true }); onLanguageChange(); } },
  }, LANGUAGES.map((lang) => el('option', { text: lang.toUpperCase(), value: lang, attrs: { selected: lang === language() } })));

  container.replaceChildren(
    el('a', { className: 'brand', text: 'EnvioTec', attrs: { href: '#/' } }),
    el('nav', { attrs: { 'aria-label': t('nav.main') } }, [el('ul', {}, links.map((item) => el('li', {}, [
      el('a', {
        text: t(item.label), attrs: { href: `#${item.path}`, 'aria-current': currentPath === item.path || (item.path !== '/' && currentPath.startsWith(item.path)) ? 'page' : null },
      }),
    ])))]),
    el('div', { className: 'session' }, [
      languageSelect,
      user && full ? el('a', { text: user.displayName, attrs: { href: '#/mi-cuenta' } }) : null,
      user ? el('button', {
        className: 'button button-ghost', text: t('nav.logout'), attrs: { type: 'button' },
        on: { click: async () => { await logout(); navigate('/ingresar'); } },
      }) : null,
    ]),
  );
}
