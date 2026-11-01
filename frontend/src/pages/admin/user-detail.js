import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { formatDate, t } from '../../core/i18n.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { dataTable } from '../../components/data-table.js';
import { badge, button, definitionList, pageHeader, section } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { statusBadge } from './users-list.js';
import { editUser, editRoles, renewUser, showSecret } from './user-dialogs.js';

// User detail with every administrative action the session may perform.
// Buttons only reflect permissions (UX); the backend checks each request.
export async function render(container, { params }) {
  const result = await run(() => api.get(`/api/v1/users/${params.id}`));
  if (!result) return;
  const user = result.data;
  const isSelf = user.id === auth.currentUser().id;
  const reload = () => render(container, { params });
  const can = (code) => auth.hasPermission(code);
  const local = user.authSource === 'local';

  async function act(path, { confirm, success, danger = false } = {}) {
    if (confirm && !await confirmDialog({ title: confirm.title, message: confirm.message, danger })) return null;
    const response = await run(() => api.post(`/api/v1/users/${user.id}/${path}`));
    if (response && success) toast(success, 'success');
    return response;
  }

  const actions = [
    can('users.update') && local ? button(t('common.edit'), () => editUser(user, reload)) : null,
    can('roles.assign') && !isSelf ? button(t('users.editRoles'), () => editRoles(user, reload)) : null,
    can('users.renew_local') && local && !user.exemptFromExpiry && !isSelf ? button(t('users.renew'), () => renewUser(user, reload)) : null,
    can('users.unlock') && user.lockedUntil ? button(t('users.unlock'), async () => {
      if (await act('unlock', { success: t('users.unlocked') })) reload();
    }) : null,
    can('users.reset_password') && local && !isSelf ? button(t('users.resetPassword'), async () => {
      const response = await act('reset-password', { confirm: { title: t('users.resetPassword'), message: t('users.resetPasswordConfirm') } });
      if (response) showSecret(t('users.temporaryPassword'), response.data.temporaryPassword, t('users.temporaryPasswordWarning'));
    }) : null,
    can('users.reset_mfa') && !isSelf ? button(t('users.resetMfa'), async () => {
      const response = await act('mfa/reset', { confirm: { title: t('users.resetMfa'), message: t('users.resetMfaConfirm') }, danger: true });
      if (!response) return;
      if (response.data.enrollmentCode) {
        showSecret(t('users.enrollmentCode'), response.data.enrollmentCode, t('users.enrollmentCodeWarning', { date: formatDate(response.data.expiresAt) }));
      } else {
        toast(t('users.mfaResetDone'), 'success');
      }
      reload();
    }) : null,
    can('users.disable') && !isSelf ? (user.status === 'active'
      ? button(t('users.disable'), async () => {
        if (await act('disable', { confirm: { title: t('users.disable'), message: t('users.disableConfirm') }, danger: true, success: t('users.disabled') })) reload();
      }, { kind: 'danger' })
      : button(t('users.enable'), async () => {
        if (await act('enable', { success: t('users.enabled') })) reload();
      })) : null,
  ];

  const permissions = can('users.view') ? await run(() => api.get(`/api/v1/users/${user.id}/permissions`)) : null;
  const sessions = can('sessions.view_any') ? dataTable({
    load: () => api.get(`/api/v1/users/${user.id}/sessions`),
    columns: [
      { key: 'createdAt', label: t('sessions.createdAt'), render: (s) => formatDate(s.createdAt) },
      { key: 'lastSeenAt', label: t('sessions.lastSeenAt'), render: (s) => formatDate(s.lastSeenAt) },
      { key: 'ip', label: t('sessions.ip') },
      { key: 'userAgent', label: t('sessions.userAgent') },
    ],
  }) : null;

  replace(container, [
    pageHeader(user.displayName, actions),
    section(t('users.detail'), definitionList([
      [t('users.username'), user.username],
      [t('users.email'), user.email],
      [t('users.authSource'), t(`users.source.${user.authSource}`)],
      [t('users.area'), user.areaName],
      [t('users.statusLabel'), statusBadge(user)],
      [t('users.mfa'), user.mfaEnabled ? badge(t('common.enabled'), 'ok') : badge(t('common.disabled'))],
      [t('users.expiresAt'), user.exemptFromExpiry ? t('users.exempt') : formatDate(user.expiresAt, { time: false })],
      [t('users.lastLogin'), formatDate(user.lastLoginAt)],
      [t('users.roles'), user.roles.length === 0 ? '—' : el('ul', { className: 'inline-list' }, user.roles.map((role) =>
        el('li', {}, [role.name, role.source === 'ad_group' ? badge(t('users.fromAd')) : null])))],
    ])),
    permissions ? section(t('users.effectivePermissions'), [
      permissions.data.mfaRequired ? el('p', {}, [badge(t('users.mfaRequired'), 'warning')]) : null,
      el('ul', { className: 'permission-list' }, permissions.data.permissions.map((p) => el('li', {}, [
        el('code', { text: p.code }), ` ${p.description} `, p.administrative ? badge(t('roles.administrative'), 'warning') : null,
        el('small', { text: ` (${p.roles.join(', ')})` }),
      ]))),
    ]) : null,
    sessions ? section(t('sessions.title'), [
      can('sessions.revoke_any') ? button(t('users.revokeSessions'), async () => {
        if (!await confirmDialog({ title: t('users.revokeSessions'), message: t('users.revokeSessionsConfirm'), danger: true })) return;
        const response = await run(() => api.delete(`/api/v1/users/${user.id}/sessions`));
        if (response) {
          toast(t('users.sessionsRevoked', { n: response.data.revoked }), 'success');
          sessions.refresh();
        }
      }, { kind: 'danger' }) : null,
      sessions.element,
    ]) : null,
  ]);
}
