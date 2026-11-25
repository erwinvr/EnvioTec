import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PERMISSION_CATALOG } from '../../backend/src/modules/permission-catalog.js';
import { BootstrapError, bootstrapAdmin, validateBootstrapInput } from '../scripts/lib/bootstrap.js';
import { seedSystem } from '../scripts/lib/seed-system.js';
import { connect, inRollback } from './helpers.js';

const VALID_INPUT = {
  username: 'admin.inicial',
  email: 'admin.inicial@example.test',
  displayName: 'Administrador inicial',
  areaName: 'Administración',
  password: 'correct horse battery staple 47',
};

describe('seed de sistema', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner.end());

  it('es idempotente', async () => {
    await inRollback(owner, async (tx) => {
      assert.deepEqual(await seedSystem(tx), { permissions: 0, roles: 0, settings: 0 });
    });
  });

  it('sincroniza todo el catálogo y superadmin tiene todos los permisos', async () => {
    const { rows } = await owner.query(
      `SELECT (SELECT COUNT(*) FROM permissions) AS catalog,
              (SELECT COUNT(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = 'superadmin') AS superadmin`,
    );
    assert.equal(rows[0].catalog, PERMISSION_CATALOG.length);
    assert.equal(rows[0].superadmin, PERMISSION_CATALOG.length);
  });

  it('crea los roles iniciales y solo superadmin es de sistema', async () => {
    const { rows } = await owner.query(
      'SELECT name, is_system, CAST(dbo.role_is_administrative(id) AS bit) AS administrative FROM roles ORDER BY name',
    );
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    for (const name of ['superadmin', 'administrador', 'operador', 'aprobador', 'auditoria', 'reportes']) {
      assert.ok(byName[name], `falta el rol ${name}`);
    }
    assert.deepEqual(rows.filter((row) => row.is_system).map((row) => row.name), ['superadmin']);
    for (const name of ['operador', 'aprobador', 'auditoria', 'reportes']) {
      assert.equal(byName[name].administrative, false, `${name} no debe ser administrativo (puede venir de AD)`);
    }
    assert.equal(byName.administrador.administrative, true);
  });

  it('falla si la base tiene un permiso que no está en el código', async () => {
    await inRollback(owner, async (tx) => {
      await tx.query("INSERT INTO permissions (code, description) VALUES ('orphan.permission', 'x')");
      await assert.rejects(seedSystem(tx), /orphan.permission/);
    });
  });

  it('no sobrescribe un parámetro modificado por un administrador', async () => {
    await inRollback(owner, async (tx) => {
      await tx.query("UPDATE system_settings SET value = '60' WHERE [key] = 'local_account.default_validity_days'");
      await seedSystem(tx);
      const { rows } = await tx.query("SELECT value FROM system_settings WHERE [key] = 'local_account.default_validity_days'");
      assert.equal(rows[0].value, 60);
    });
  });
});

describe('bootstrap del superadmin', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner.end());

  it('valida los datos y la política de contraseñas', () => {
    assert.deepEqual(validateBootstrapInput(VALID_INPUT), []);
    const problems = validateBootstrapInput({ ...VALID_INPUT, username: 'a', email: 'no-email', password: 'Password2026!' });
    assert.equal(problems.length, 3);
    assert.ok(validateBootstrapInput({ ...VALID_INPUT, password: 'admin.inicial-secreto' }).some((p) => /usuario/.test(p)));
  });

  it('crea un superadmin local con vigencia y rechaza un segundo', async () => {
    await inRollback(owner, async (tx) => {
      const result = await bootstrapAdmin(tx, VALID_INPUT);
      const { rows } = await tx.query(
        `SELECT u.auth_source, u.exempt_from_expiry, u.is_emergency, u.password_hash, CAST(CASE WHEN u.expires_at > DATEADD(day, 89, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS bit) AS valid_90,
                r.name AS role
           FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.id = $1`,
        [result.userId],
      );
      assert.equal(rows[0].auth_source, 'local');
      assert.equal(rows[0].role, 'superadmin');
      const { rows: audit } = await tx.query(
        "SELECT actor_type, result, metadata FROM audit_logs WHERE action = 'user.bootstrap' AND resource_id = $1",
        [result.userId],
      );
      assert.deepEqual(audit, [{ actor_type: 'system', result: 'success', metadata: { emergency: false, role: 'superadmin' } }]);
      assert.equal(rows[0].exempt_from_expiry, false);
      assert.equal(rows[0].valid_90, true);
      assert.match(rows[0].password_hash, /^\$argon2id\$v=19\$/);
      assert.ok(!rows[0].password_hash.includes(VALID_INPUT.password));

      await assert.rejects(
        bootstrapAdmin(tx, { ...VALID_INPUT, username: 'otro.admin', email: 'otro@example.test' }),
        (error) => error instanceof BootstrapError && /Ya existe un superadmin/.test(error.message),
      );
    });
  });

  it('crea una única cuenta de emergencia exenta de vigencia', async () => {
    await inRollback(owner, async (tx) => {
      const input = { ...VALID_INPUT, username: 'emergencia', email: 'emergencia@example.test' };
      const result = await bootstrapAdmin(tx, input, { emergency: true });
      const { rows } = await tx.query('SELECT is_emergency, exempt_from_expiry, expires_at FROM users WHERE id = $1', [result.userId]);
      assert.deepEqual(rows[0], { is_emergency: true, exempt_from_expiry: true, expires_at: null });
      await assert.rejects(
        bootstrapAdmin(tx, { ...input, username: 'emergencia2', email: 'e2@example.test' }, { emergency: true }),
        /Ya existe una cuenta de emergencia/,
      );
    });
  });

  it('rechaza usuarios o emails ya usados', async () => {
    await inRollback(owner, async (tx) => {
      await bootstrapAdmin(tx, VALID_INPUT, { emergency: true });
      await assert.rejects(bootstrapAdmin(tx, { ...VALID_INPUT, email: 'x@example.test' }), /ya están en uso/);
    });
  });
});
