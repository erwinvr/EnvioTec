import { createAuditService } from '../../../backend/src/core/audit/audit.service.js';
import { inJson } from '../../../backend/src/core/db/sql.js';
import { PERMISSION_CATALOG } from '../../../backend/src/modules/permission-catalog.js';
import { ROLES } from '../../seeds/system/roles.js';
import { SETTINGS } from '../../seeds/system/settings.js';

// Idempotent synchronization of the permission catalog, the initial roles and
// the system parameters. Runs inside the caller's transaction and fails, leaving
// everything unchanged, if the database and the code disagree in a way that
// needs a human decision.
export async function seedSystem(client) {
  const permissions = await syncPermissions(client);
  const roles = await syncRoles(client);
  const settings = await syncSettings(client);
  // A7: catalog changes are administrative actions; a run that changes
  // nothing leaves no event.
  if (permissions + roles + settings > 0) {
    await createAuditService().record(client, {
      actor: { type: 'system' }, action: 'system.seed_sync', resourceType: 'catalog', result: 'success',
      metadata: { permissions, roles, settings },
    });
  }
  return { permissions, roles, settings };
}

async function syncPermissions(client) {
  const codes = PERMISSION_CATALOG.map((permission) => permission.code);
  const { rows: unknown } = await client.query(
    `SELECT code FROM permissions WHERE code NOT IN ${inJson('$1')} ORDER BY code`,
    [codes],
  );
  if (unknown.length > 0) {
    throw new Error(`La base tiene permisos que no están en el código: ${unknown.map((row) => row.code).join(', ')}. `
      + 'Elimínelos con una migración explícita.');
  }

  let changed = 0;
  for (const permission of PERMISSION_CATALOG) {
    const { rows } = await client.query(
      `IF NOT EXISTS (SELECT 1 FROM permissions WITH (UPDLOCK, HOLDLOCK) WHERE code = $1)
       BEGIN
         INSERT INTO permissions (code, description, is_administrative) VALUES ($1, $2, $3);
         SELECT 1 AS changed;
       END
       ELSE
       BEGIN
         UPDATE permissions SET description = $2, is_administrative = $3, updated_at = SYSUTCDATETIME()
          WHERE code = $1 AND (description <> $2 COLLATE Latin1_General_BIN OR is_administrative <> $3);
         SELECT @@ROWCOUNT AS changed;
       END`,
      [permission.code, permission.description, permission.administrative],
    );
    changed += rows[0].changed;
  }

  // ADR-007: a permission that becomes administrative cannot stay in a role
  // that AD accounts hold or that an AD group maps to.
  const { rows: conflicts } = await client.query(
    `SELECT DISTINCT r.name FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id AND p.is_administrative = 1
      WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
                     WHERE ur.role_id = r.id AND (u.auth_source = 'ad' OR ur.source = 'ad_group'))
         OR EXISTS (SELECT 1 FROM ad_group_role_mappings m WHERE m.role_id = r.id)`,
  );
  if (conflicts.length > 0) {
    throw new Error(`Roles usados desde AD quedarían con permisos administrativos: ${conflicts.map((row) => row.name).join(', ')}`);
  }
  return changed;
}

async function syncRoles(client) {
  const known = new Set(PERMISSION_CATALOG.map((permission) => permission.code));
  let created = 0;
  for (const role of ROLES) {
    const codes = role.permissions === 'all' ? [...known] : role.permissions;
    const missing = codes.filter((code) => !known.has(code));
    if (missing.length > 0) throw new Error(`El rol ${role.name} usa permisos inexistentes: ${missing.join(', ')}`);

    // roles has a guard trigger: no OUTPUT, the new row is read back.
    const { rows } = await client.query(
      `IF NOT EXISTS (SELECT 1 FROM roles WITH (UPDLOCK, HOLDLOCK) WHERE name = $1)
       BEGIN
         INSERT INTO roles (name, description, is_system) VALUES ($1, $2, $3);
         SELECT 1 AS created;
       END
       ELSE SELECT 0 AS created;`,
      [role.name, role.description, role.isSystem === true],
    );
    const isNew = rows[0].created === 1;
    if (isNew) created += 1;
    // New roles get their initial permissions; system roles always get the
    // whole catalog (new permissions included).
    if (isNew || role.isSystem) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
          WHERE r.name = $1 AND p.code IN ${inJson('$2')}
            AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id)`,
        [role.name, codes],
      );
    }
  }
  return created;
}

async function syncSettings(client) {
  let changed = 0;
  for (const setting of SETTINGS) {
    const isInteger = setting.type === 'integer';
    // Keys, types, ranges and descriptions come from the code; the value is
    // set only when the parameter is new (afterwards it belongs to the admins).
    const { rows } = await client.query(
      `IF NOT EXISTS (SELECT 1 FROM system_settings WITH (UPDLOCK, HOLDLOCK) WHERE [key] = $1)
       BEGIN
         INSERT INTO system_settings ([key], value_type, value, min_value, max_value, description) VALUES ($1, $2, $3, $4, $5, $6);
         SELECT 1 AS changed;
       END
       ELSE
       BEGIN
         UPDATE system_settings SET value_type = $2, min_value = $4, max_value = $5, description = $6
          WHERE [key] = $1
            AND EXISTS (SELECT value_type, min_value, max_value, description COLLATE Latin1_General_BIN
                        EXCEPT SELECT $2, $4, $5, $6 COLLATE Latin1_General_BIN);
         SELECT @@ROWCOUNT AS changed;
       END`,
      [setting.key, setting.type, JSON.stringify(setting.value),
        isInteger ? setting.min : null, isInteger ? setting.max : null, setting.description],
    );
    changed += rows[0].changed;
  }
  return changed;
}
