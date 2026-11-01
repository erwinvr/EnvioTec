import { api } from '../../core/api.js';
import { auth } from '../../core/auth.js';
import { el, replace } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { navigate } from '../../core/router.js';
import { confirmDialog } from '../../components/confirm-dialog.js';
import { createForm } from '../../components/form.js';
import { badge, button, definitionList, pageHeader, section } from '../../components/page.js';
import { toast } from '../../components/toast.js';

// Permissions grouped by module (the part before the dot); administrative
// ones are marked. Only permissions the session holds can be changed: the
// backend rejects the rest (A6 rule 1), the UI just disables them.
export async function render(container, { params }) {
  const [roleResult, catalog] = await Promise.all([
    run(() => api.get(`/api/v1/roles/${params.id}`)),
    auth.hasPermission('permissions.view') ? run(() => api.get('/api/v1/permissions')) : null,
  ]);
  if (!roleResult) return;
  const role = roleResult.data;
  const reload = () => render(container, { params });
  const editable = auth.hasPermission('roles.update') && !role.isSystem && catalog;

  const editForm = auth.hasPermission('roles.update') ? createForm({
    fields: [
      { name: 'name', label: t('roles.name'), required: true, pattern: '[a-z][a-z0-9_-]{1,49}', value: role.name },
      { name: 'description', label: t('roles.description'), type: 'textarea', maxLength: 500, value: role.description },
    ],
    submitLabel: t('common.save'),
    onSubmit: async (values) => {
      const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== role[key]));
      if (Object.keys(changes).length > 0 && await run(() => api.patch(`/api/v1/roles/${role.id}`, changes), { form: editForm })) {
        toast(t('common.saved'), 'success');
        reload();
      }
    },
  }) : null;

  let permissionsForm = null;
  if (editable) {
    const groups = new Map();
    for (const permission of catalog.data) {
      const module = permission.code.split('.')[0];
      if (!groups.has(module)) groups.set(module, []);
      groups.get(module).push(permission);
    }
    permissionsForm = createForm({
      fields: [...groups].map(([module, permissions]) => ({
        name: `group_${module}`, label: module, type: 'checkboxes',
        value: role.permissions,
        options: permissions.map((p) => ({ value: p.code, label: `${p.code} — ${p.description}`, badge: p.administrative ? t('roles.administrative') : null })),
      })),
      submitLabel: t('roles.savePermissions'),
      onSubmit: async (values) => {
        const permissions = Object.values(values).flat();
        if (await run(() => api.put(`/api/v1/roles/${role.id}/permissions`, { permissions }), { form: permissionsForm })) {
          toast(t('roles.permissionsSaved'), 'success');
          reload();
        }
      },
    });
    for (const input of permissionsForm.element.querySelectorAll('input[type="checkbox"]')) {
      if (!auth.hasPermission(input.value)) input.disabled = true;
    }
  }

  replace(container, [
    pageHeader(role.name, [
      auth.hasPermission('roles.delete') && !role.isSystem ? button(t('common.delete'), async () => {
        if (!await confirmDialog({ title: t('roles.delete'), message: t('roles.deleteConfirm', { name: role.name }), danger: true })) return;
        if (await run(() => api.delete(`/api/v1/roles/${role.id}`))) {
          toast(t('roles.deleted'), 'success');
          navigate('/roles');
        }
      }, { kind: 'danger' }) : null,
    ]),
    section(t('roles.detail'), definitionList([
      [t('roles.description'), role.description || '—'],
      [t('roles.users'), String(role.userCount)],
      [t('roles.flags'), el('span', {}, [
        role.isSystem ? badge(t('roles.system')) : null,
        role.administrative ? badge(t('roles.administrative'), 'warning') : null,
        role.usedFromAd ? badge(t('roles.usedFromAd')) : null,
      ])],
      [t('roles.adGroups'), (role.adGroups ?? []).length === 0 ? '—' : el('ul', {}, role.adGroups.map((g) => el('li', {}, [el('code', { text: g.groupDn })])))],
    ])),
    editForm && !role.isSystem ? section(t('common.edit'), editForm.element) : null,
    section(t('roles.permissions'), editable
      ? [el('p', { text: t('roles.permissionsHelp') }), permissionsForm.element]
      : el('ul', { className: 'permission-list' }, role.permissions.map((code) => el('li', {}, [el('code', { text: code })])))),
  ]);
}
