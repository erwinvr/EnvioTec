import { actorFrom } from '../../core/audit/audit.service.js';
import { assertRecentReauth } from '../../core/authorization/authorization.js';
import { withTransaction } from '../../core/db/transaction.js';
import { NotFoundError } from '../../core/errors/errors.js';
import { assertConsistent, normalizeSettingValue } from './settings.rules.js';

const toSetting = (row) => ({
  key: row.key, type: row.value_type, value: row.value, min: row.min_value, max: row.max_value,
  description: row.description, updatedAt: row.updated_at.toISOString(),
});

export function createSettingsService({ db, repository, audit }) {
  return {
    async list() {
      return (await repository.list(db)).map(toSetting);
    },

    // settings.manage + reauthentication; audited with the old and new value (Parte B).
    async update(auth, key, value, context) {
      assertRecentReauth(auth);
      return withTransaction(db, async (client) => {
        const setting = await repository.findForUpdate(client, key);
        if (!setting) throw new NotFoundError();
        const normalized = normalizeSettingValue(setting, value);
        if (setting.value_type === 'integer') {
          const values = Object.fromEntries((await repository.list(client)).map((row) => [row.key, row.value]));
          assertConsistent(key, normalized, values);
        }
        const updated = await repository.update(client, key, normalized, auth.user.id);
        await audit.record(client, {
          actor: actorFrom(auth), action: 'setting.update', resourceType: 'setting', resourceId: key, result: 'success',
          context, metadata: { before: setting.value, after: normalized },
        });
        return toSetting(updated);
      });
    },
  };
}
