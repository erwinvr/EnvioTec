import { api } from '../../core/api.js';
import { el } from '../../core/dom.js';
import { run } from '../../core/feedback.js';
import { t } from '../../core/i18n.js';
import { createForm } from '../../components/form.js';
import { openModal } from '../../components/modal.js';
import { secretBox } from '../../components/page.js';
import { toast } from '../../components/toast.js';
import { areas, optionsOf, roles } from './lookups.js';

function formModal(title, form, intro) {
  return openModal({ title, content: [intro ? el('p', { text: intro }) : null, form.element] });
}

export function showSecret(title, value, warning) {
  openModal({ title, content: secretBox(title, value, warning) });
}

export async function editUser(user, done) {
  const areaList = (await run(areas)) ?? [];
  const form = createForm({
    fields: [
      { name: 'displayName', label: t('users.displayName'), required: true, maxLength: 200, value: user.displayName },
      { name: 'email', label: t('users.email'), type: 'email', required: true, maxLength: 254, value: user.email, hint: t('users.emailReauthHint') },
      { name: 'areaId', label: t('users.area'), type: 'select', required: true, value: user.areaId, options: optionsOf(areaList.filter((a) => a.isActive || a.id === user.areaId)) },
    ],
    submitLabel: t('common.save'),
    onSubmit: async (values) => {
      const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== user[key]));
      if (Object.keys(changes).length === 0) return modal.close();
      if (await run(() => api.patch(`/api/v1/users/${user.id}`, changes), { form })) {
        toast(t('common.saved'), 'success');
        modal.close();
        done();
      }
      return undefined;
    },
  });
  const modal = formModal(t('common.edit'), form);
}

// Manual roles only; roles that come from AD groups are listed but not editable.
export async function editRoles(user, done) {
  const roleList = (await run(roles)) ?? [];
  const fromAd = new Set(user.roles.filter((r) => r.source === 'ad_group').map((r) => r.id));
  const form = createForm({
    fields: [{
      name: 'roleIds', label: t('users.roles'), type: 'checkboxes',
      value: user.roles.filter((r) => r.source === 'manual').map((r) => r.id),
      options: roleList.filter((role) => !fromAd.has(role.id) && !(user.authSource === 'ad' && role.administrative)).map((role) => ({
        value: role.id, label: role.name, badge: role.administrative ? t('roles.administrative') : null,
      })),
      hint: fromAd.size > 0 ? t('users.adRolesHint') : null,
    }],
    submitLabel: t('common.save'),
    onSubmit: async (values) => {
      if (await run(() => api.put(`/api/v1/users/${user.id}/roles`, values), { form })) {
        toast(t('users.rolesSaved'), 'success');
        modal.close();
        done();
      }
    },
  });
  const modal = formModal(t('users.editRoles'), form, t('users.rolesHelp'));
}

export function renewUser(user, done) {
  const form = createForm({
    fields: [
      { name: 'days', label: t('users.renewDays'), type: 'number', required: true, min: 1, max: 365, value: 90 },
      { name: 'reason', label: t('users.renewReason'), type: 'textarea', required: true, minLength: 10, maxLength: 500 },
    ],
    submitLabel: t('users.renew'),
    onSubmit: async (values) => {
      if (await run(() => api.post(`/api/v1/users/${user.id}/renew`, values), { form })) {
        toast(t('users.renewed'), 'success');
        modal.close();
        done();
      }
    },
  });
  const modal = formModal(t('users.renew'), form, t('users.renewHelp'));
}
