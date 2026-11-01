import { hashPassword } from '../../../backend/src/core/auth/password.js';
import { checkPassword } from '../../../backend/src/core/auth/password-policy.js';

// Creates the initial superadmin or the emergency account (A6, Parte B). No
// default credentials exist: whoever runs the bootstrap defines the password.
// Both accounts are local superadmins; the emergency account is exempt from
// expiry but not from MFA, which is enrolled on first login (phase 3).

export class BootstrapError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'BootstrapError';
    this.problems = problems;
  }
}

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const PASSWORD_MESSAGES = {
  too_short: 'La contraseña debe tener al menos 12 caracteres.',
  too_long: 'La contraseña no puede superar los 128 caracteres.',
  common: 'La contraseña es demasiado común o una variación de una contraseña común.',
  repetitive: 'La contraseña tiene muy pocos caracteres distintos.',
  contains_account_data: 'La contraseña no puede contener el usuario, el email ni el nombre de la aplicación.',
  invalid: 'La contraseña es inválida.',
};

export function validateBootstrapInput({ username, email, displayName, areaName, password }) {
  const problems = [];
  if (!USERNAME_PATTERN.test(username ?? '')) problems.push('Usuario: 3 a 64 caracteres (letras, números, punto, guion y guion bajo).');
  if (!EMAIL_PATTERN.test(email ?? '') || email.length > 254) problems.push('Email inválido.');
  if (!displayName || displayName.length > 200) problems.push('Nombre: entre 1 y 200 caracteres.');
  if (!areaName || areaName.length < 2 || areaName.length > 100) problems.push('Área: entre 2 y 100 caracteres.');
  for (const code of checkPassword(password, { username, email })) problems.push(PASSWORD_MESSAGES[code]);
  return problems;
}

// Must run inside a transaction (see inLockedTransaction).
export async function bootstrapAdmin(client, input, { emergency = false, argon2 } = {}) {
  const problems = validateBootstrapInput(input);
  if (problems.length > 0) throw new BootstrapError(problems);

  const { rows: roleRows } = await client.query("SELECT id FROM roles WHERE name = 'superadmin' AND is_system");
  if (roleRows.length === 0) throw new BootstrapError(['Falta el rol superadmin: ejecute primero el seed de sistema.']);
  const roleId = roleRows[0].id;

  if (emergency) {
    const { rowCount } = await client.query('SELECT 1 FROM users WHERE is_emergency AND deleted_at IS NULL');
    if (rowCount > 0) throw new BootstrapError(['Ya existe una cuenta de emergencia.']);
  } else {
    const { rowCount } = await client.query(
      `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id
        WHERE ur.role_id = $1 AND u.deleted_at IS NULL AND NOT u.is_emergency`,
      [roleId],
    );
    if (rowCount > 0) throw new BootstrapError(['Ya existe un superadmin. Los demás usuarios se crean desde la aplicación.']);
  }

  const { rowCount: taken } = await client.query(
    'SELECT 1 FROM users WHERE username = $1 OR email = $2',
    [input.username, input.email],
  );
  if (taken > 0) throw new BootstrapError(['El usuario o el email ya están en uso.']);

  await client.query('INSERT INTO areas (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [input.areaName]);
  const { rows: areaRows } = await client.query('SELECT id FROM areas WHERE name = $1', [input.areaName]);

  const { rows: settingRows } = await client.query(
    "SELECT (value #>> '{}')::integer AS days FROM system_settings WHERE key = 'local_account.default_validity_days'",
  );
  if (!emergency && settingRows.length === 0) {
    throw new BootstrapError(['Faltan los parámetros del sistema: ejecute primero el seed de sistema.']);
  }

  const passwordHash = await hashPassword(input.password, argon2);
  const { rows: userRows } = await client.query(
    `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, password_changed_at,
                        expires_at, exempt_from_expiry, is_emergency)
     VALUES ($1, $2, $3, 'local', $4, $5, now(),
             CASE WHEN $6 THEN NULL ELSE now() + make_interval(days => $7) END, $6, $6)
     RETURNING id, expires_at`,
    [input.username, input.email, input.displayName, passwordHash, areaRows[0].id, emergency,
      emergency ? 0 : settingRows[0].days],
  );
  await client.query("INSERT INTO user_roles (user_id, role_id, source) VALUES ($1, $2, 'manual')", [userRows[0].id, roleId]);
  // Audited in the same transaction (A7): the account and its event exist together or not at all.
  await client.query(
    `SELECT append_audit_log('system', NULL, NULL, 'user.bootstrap', 'user', $1, 'success', NULL, NULL, NULL,
                             jsonb_build_object('emergency', $2::boolean, 'role', 'superadmin'))`,
    [userRows[0].id, emergency],
  );

  return { userId: userRows[0].id, expiresAt: userRows[0].expires_at };
}
