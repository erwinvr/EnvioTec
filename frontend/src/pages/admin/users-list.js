import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { navigate } from '../../core/router.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, pageHeader } from '../../components/page.js';
import { areas, optionsOf, roles } from './lookups.js';

export function statusBadge(user) {
  if (user.lockedUntil) return badge(t('users.status.locked'), 'warning');
  return badge(t(`users.status.${user.status}`), user.status === 'active' ? 'ok' : 'muted');
}

export async function render(container) {
  const [areaList, roleList] = await Promise.all([run(areas), auth.hasPermission('roles.view') ? run(roles) : []]);
  const table = dataTable({
    initialSort: { key: 'username' },
    load: (query) => api.get('/api/v1/users', query),
    filters: [
      { name: 'search', label: t('common.search') },
      { name: 'status', label: t('users.statusLabel'), type: 'select', options: ['active', 'disabled'].map((s) => ({ value: s, label: t(`users.status.${s}`) })) },
      { name: 'authSource', label: t('users.authSource'), type: 'select', options: ['local', 'ad'].map((s) => ({ value: s, label: t(`users.source.${s}`) })) },
      { name: 'areaId', label: t('users.area'), type: 'select', options: optionsOf(areaList ?? []) },
      ...(roleList?.length ? [{ name: 'roleId', label: t('users.roles'), type: 'select', options: optionsOf(roleList) }] : []),
    ],
    columns: [
      { key: 'username', label: t('users.username'), sortable: true, render: (u) => el('a', { text: u.username, attrs: { href: `#/usuarios/${u.id}` } }) },
      { key: 'displayName', label: t('users.displayName'), sortable: true },
      { key: 'authSource', label: t('users.authSource'), render: (u) => t(`users.source.${u.authSource}`) },
      { key: 'areaName', label: t('users.area') },
      { key: 'status', label: t('users.statusLabel'), render: statusBadge },
      { key: 'roles', label: t('users.roles'), render: (u) => u.roles.map((r) => r.name).join(', ') || '—' },
      { key: 'lastLoginAt', label: t('users.lastLogin'), sortable: true, render: (u) => formatDate(u.lastLoginAt) },
      { key: 'expiresAt', label: t('users.expiresAt'), sortable: true, render: (u) => formatDate(u.expiresAt, { time: false }) },
    ],
  });
  replace(container, [
    pageHeader(t('nav.users'), [
      button(t('users.reviewTitle'), () => navigate('/usuarios/revision')),
      auth.hasPermission('users.create_local') ? button(t('users.create'), () => navigate('/usuarios/nuevo'), { kind: 'primary' }) : null,
    ]),
    table.element,
  ]);
}
