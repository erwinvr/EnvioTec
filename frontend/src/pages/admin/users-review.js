import { api } from '../../core/api.js';
import { el, replace } from '../../core/dom.js';
import { formatDate, t } from '../../core/i18n.js';
import { dataTable } from '../../components/data-table.js';
import { badge, pageHeader } from '../../components/page.js';

// Periodic review of local accounts (Parte B).
export function render(container) {
  const table = dataTable({
    load: (query) => api.get('/api/v1/users/review/local', query),
    columns: [
      { key: 'username', label: t('users.username'), render: (u) => el('a', { text: u.username, attrs: { href: `#/usuarios/${u.id}` } }) },
      { key: 'displayName', label: t('users.displayName') },
      { key: 'areaName', label: t('users.area') },
      { key: 'lastLoginAt', label: t('users.lastLogin'), render: (u) => formatDate(u.lastLoginAt) },
      { key: 'inactiveDays', label: t('users.inactiveDays') },
      {
        key: 'expiresAt', label: t('users.expiresAt'),
        render: (u) => (u.exemptFromExpiry ? badge(t('users.exempt')) : formatDate(u.expiresAt, { time: false })),
      },
      { key: 'isEmergency', label: '', render: (u) => (u.isEmergency ? badge(t('users.emergency'), 'warning') : '') },
    ],
  });
  replace(container, [pageHeader(t('users.reviewTitle')), el('p', { text: t('users.reviewHelp') }), table.element]);
}
