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
  return { permissions, roles, settings };
}

async function syncPermissions(client) {
  const codes = PERMISSION_CATALOG.map((permission) => permission.code);
  const { rows: unknown } = await client.query(
    'SELECT code FROM permissions WHERE NOT (code = ANY($1::text[])) ORDER BY code',
    [codes],
  );
  if (unknown.length > 0) {
    throw new Error(`La base tiene permisos que no están en el código: ${unknown.map((row) => row.code).join(', ')}. `
      + 'Elimínelos con una migración explícita.');
  }

  let changed = 0;
  for (const permission of PERMISSION_CATALOG) {
    const { rowCount } = await client.query(
      `INSERT INTO permissions (code, description, is_administrative) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, is_administrative = EXCLUDED.is_administrative
         WHERE permissions.description IS DISTINCT FROM EXCLUDED.description
            OR permissions.is_administrative IS DISTINCT FROM EXCLUDED.is_administrative`,
      [permission.code, permission.description, permission.administrative],
    );
    changed += rowCount;
  }

  // ADR-007: a permission that becomes administrative cannot stay in a role
  // that AD accounts hold or that an AD group maps to.
  const { rows: conflicts } = await client.query(
    `SELECT DISTINCT r.name FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id AND p.is_administrative
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

    const { rows } = await client.query(
      `INSERT INTO roles (name, description, is_system) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING RETURNING id`,
      [role.name, role.description, role.isSystem === true],
    );
    const isNew = rows.length === 1;
    if (isNew) created += 1;
    // New roles get their initial permissions; system roles always get the
    // whole catalog (new permissions included).
    if (isNew || role.isSystem) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
          WHERE r.name = $1 AND p.code = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
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
    const { rowCount } = await client.query(
      `INSERT INTO system_settings (key, value_type, value, min_value, max_value, description)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET value_type = EXCLUDED.value_type, min_value = EXCLUDED.min_value,
         max_value = EXCLUDED.max_value, description = EXCLUDED.description
         WHERE (system_settings.value_type, system_settings.min_value, system_settings.max_value, system_settings.description)
           IS DISTINCT FROM (EXCLUDED.value_type, EXCLUDED.min_value, EXCLUDED.max_value, EXCLUDED.description)`,
      [setting.key, setting.type, JSON.stringify(setting.value),
        isInteger ? setting.min : null, isInteger ? setting.max : null, setting.description],
    );
    changed += rowCount;
  }
  return changed;
}
