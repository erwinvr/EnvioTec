import { auth, logout } from '../core/auth.js';
import { el, svg } from '../core/dom.js';
import { language, LANGUAGES, setLanguage, t } from '../core/i18n.js';
import { navigate } from '../core/router.js';

// Menu entries are shown according to permissions (UX only, A6), grouped
// by task. A group without visible entries is not shown.
const GROUPS = [
  { label: null, items: [{ path: '/', label: 'nav.home' }] },
  {
    label: 'nav.groupSending',
    items: [
      { path: '/campanias', label: 'nav.campaigns', permission: 'campaigns.view' },
      { path: '/plantillas', label: 'nav.templates', permission: 'templates.view' },
    ],
  },
  {
    label: 'nav.groupContacts',
    items: [
      { path: '/contactos', label: 'nav.contacts', permission: 'contacts.view' },
      { path: '/supresion', label: 'nav.suppressions', permission: 'suppressions.view' },
    ],
  },
  {
    label: 'nav.groupResults',
    items: [
      { path: '/reportes', label: 'nav.reports', permission: 'reports.view' },
      { path: '/mis-envios', label: 'nav.myQuota', permission: 'quotas.view' },
    ],
  },
  {
    label: 'nav.groupAdmin',
    items: [
      { path: '/usuarios', label: 'nav.users', permission: 'users.view' },
      { path: '/roles', label: 'nav.roles', permission: 'roles.view' },
      { path: '/areas', label: 'nav.areas', permission: 'areas.manage' },
      { path: '/directorio', label: 'nav.directory', permission: 'directory.manage' },
      { path: '/remitentes', label: 'nav.senders', permission: 'senders.manage' },
      { path: '/cuotas', label: 'nav.quotas', permission: 'quotas.manage' },
      { path: '/parametros', label: 'nav.settings', permission: 'settings.manage' },
      { path: '/auditoria', label: 'nav.audit', permission: 'audit.view' },
    ],
  },
];

const MOBILE = '(max-width: 900px)';

export function visibleGroups(hasPermission) {
  return GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.permission || hasPermission(item.permission)) }))
    .filter((group) => group.items.length > 0);
}

export function isCurrent(itemPath, currentPath) {
  return currentPath === itemPath || (itemPath !== '/' && currentPath.startsWith(`${itemPath}/`));
}

export function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';
}

// The EnvioTec mark: an envelope on a rounded square.
function brandMark() {
  return svg('svg', { class: 'brand-mark', viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' }, [
    svg('rect', { width: 32, height: 32, rx: 9, fill: '#6c47ff' }),
    svg('rect', { x: 7, y: 10, width: 18, height: 13, rx: 2.5, fill: 'none', stroke: '#fff', 'stroke-width': 2 }),
    svg('path', { d: 'M8 11.5l8 6 8-6', fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  ]);
}

function brand() {
  return el('a', { className: 'brand', attrs: { href: '#/' } }, [brandMark(), el('span', { text: 'EnvioTec' })]);
}

function setMenu(shell, sidebar, toggle, open) {
  shell.classList.toggle('menu-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  // Off-screen links must not take the keyboard focus on small screens.
  sidebar.inert = !open && window.matchMedia(MOBILE).matches;
}

// Draws the sidebar (menu by permission) and the top bar (menu button on
// small screens, language, user, sign out). Signed out: top bar only.
export function renderNavigation({ shell, sidebar, topbar }, currentPath, onLanguageChange) {
  const user = auth.currentUser();
  const full = auth.stage() === 'full';
  const groups = full ? visibleGroups(auth.hasPermission) : [];

  shell.classList.toggle('has-sidebar', groups.length > 0);
  sidebar.replaceChildren(...(groups.length === 0 ? [] : [
    brand(),
    el('nav', { attrs: { 'aria-label': t('nav.main') } }, groups.map((group) => el('div', { className: 'nav-group' }, [
      group.label ? el('p', { className: 'nav-group-title', text: t(group.label) }) : null,
      el('ul', {}, group.items.map((item) => el('li', {}, [
        el('a', { text: t(item.label), attrs: { href: `#${item.path}`, 'aria-current': isCurrent(item.path, currentPath) ? 'page' : null } }),
      ]))),
    ]))),
  ]));

  const toggle = el('button', {
    className: 'button button-ghost menu-toggle', text: t('nav.menu'),
    attrs: { type: 'button', 'aria-controls': 'nav', 'aria-expanded': 'false' },
    on: { click: () => setMenu(shell, sidebar, toggle, !shell.classList.contains('menu-open')) },
  });
  setMenu(shell, sidebar, toggle, false);

  const languageSelect = el('select', {
    className: 'language', attrs: { 'aria-label': t('nav.language') },
    on: { change: (event) => { setLanguage(event.target.value, { persist: true }); onLanguageChange(); } },
  }, LANGUAGES.map((lang) => el('option', { text: lang.toUpperCase(), value: lang, attrs: { selected: lang === language() } })));

  topbar.replaceChildren(
    groups.length > 0 ? toggle : null,
    brand(),
    el('div', { className: 'session' }, [
      languageSelect,
      user && full ? el('a', { className: 'user-chip', attrs: { href: '#/mi-cuenta', 'aria-label': `${t('nav.account')}: ${user.displayName}` } }, [
        el('span', { className: 'avatar', text: initials(user.displayName), attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'user-name', text: user.displayName }),
      ]) : null,
      user ? el('button', {
        className: 'button button-ghost', text: t('nav.logout'), attrs: { type: 'button' },
        on: { click: async () => { await logout(); navigate('/ingresar'); } },
      }) : null,
    ]),
  );
}
