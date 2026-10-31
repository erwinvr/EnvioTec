// Database-level guards that do not depend on the application (defense in
// depth). Run with the owner user, which has every table privilege: the
// guards must hold even then.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  connect, expectFailure, inRollback, insertAdUser, insertArea, insertLocalUser, roleId,
} from './helpers.js';

describe('restricciones y triggers de la base de datos', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner.end());

  it('la auditoría es append-only incluso para el dueño de la tabla', async () => {
    await inRollback(owner, async () => {
      await owner.query(`INSERT INTO audit_logs (actor_type, action, result, hash)
                         VALUES ('system', 'test.event', 'success', decode(repeat('ab', 32), 'hex'))`);
      await expectFailure(owner, "UPDATE audit_logs SET result = 'failure'", [], /append-only/);
      await expectFailure(owner, 'DELETE FROM audit_logs', [], /append-only/);
      await expectFailure(owner, 'TRUNCATE audit_logs', [], /append-only/);
    });
  });

  it('existen las particiones mensuales de auditoría del mes actual en adelante', async () => {
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_logs'::regclass`,
    );
    assert.ok(rows[0].n >= 13);
    await inRollback(owner, async () => {
      const { rows: created } = await owner.query("SELECT create_monthly_partitions('audit_logs', 12) AS n");
      assert.equal(created[0].n, 0, 'la función es idempotente');
    });
  });

  it('cada cuenta tiene un único origen con sus campos coherentes', async () => {
    await inRollback(owner, async () => {
      const areaId = await insertArea(owner);
      await expectFailure(owner,
        `INSERT INTO users (username, email, display_name, auth_source, password_hash, ad_object_guid)
         VALUES ('ad.pw', 'ad.pw@example.test', 'x', 'ad', 'hash', gen_random_uuid())`, [], /users_auth_source_fields/);
      await expectFailure(owner,
        `INSERT INTO users (username, email, display_name, auth_source, password_hash, expires_at)
         VALUES ('local.noarea', 'l@example.test', 'x', 'local', 'hash', now() + interval '1 day')`, [], /users_auth_source_fields/);
      await expectFailure(owner,
        `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id)
         VALUES ('local.noexp', 'l2@example.test', 'x', 'local', 'hash', $1)`, [areaId], /users_local_expiry/);
      await expectFailure(owner,
        `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid, is_emergency)
         VALUES ('ad.em', 'ad.em@example.test', 'x', 'ad', gen_random_uuid(), true)`, [], /users_emergency_is_local/);

      const userId = await insertLocalUser(owner, areaId, 'origin');
      await expectFailure(owner, "UPDATE users SET auth_source = 'ad' WHERE id = $1", [userId], /authentication source/);
    });
  });

  it('usuario y email son únicos sin distinguir mayúsculas, entre ambos orígenes', async () => {
    await inRollback(owner, async () => {
      const areaId = await insertArea(owner);
      await insertLocalUser(owner, areaId, 'dup');
      await expectFailure(owner,
        `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid)
         VALUES ('LOCAL.DUP', 'otro@example.test', 'x', 'ad', gen_random_uuid())`, [], /users_username_key/);
      await expectFailure(owner,
        `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid)
         VALUES ('otro', 'Local.Dup@Example.Test', 'x', 'ad', gen_random_uuid())`, [], /users_email_key/);
    });
  });

  it('un rol administrativo no se asigna a una cuenta de AD ni desde un grupo de AD (ADR-007)', async () => {
    await inRollback(owner, async () => {
      const adUser = await insertAdUser(owner);
      const localUser = await insertLocalUser(owner, await insertArea(owner));
      const admin = await roleId(owner, 'administrador');
      const operator = await roleId(owner, 'operador');

      await expectFailure(owner, 'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [adUser, admin], /only be assigned to local accounts/);
      await expectFailure(owner, "INSERT INTO user_roles (user_id, role_id, source) VALUES ($1, $2, 'ad_group')", [localUser, admin], /cannot come from AD groups/);
      await expectFailure(owner, "INSERT INTO ad_group_role_mappings (group_dn, role_id) VALUES ('CN=Admins,DC=x', $1)", [admin], /cannot be mapped/);

      await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [adUser, operator]);
      await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [localUser, admin]);
    });
  });

  it('un rol usado desde AD no puede recibir permisos administrativos', async () => {
    await inRollback(owner, async () => {
      const operator = await roleId(owner, 'operador');
      await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [await insertAdUser(owner), operator]);
      await expectFailure(owner,
        "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = 'roles.assign'",
        [operator], /administrative permissions cannot be added/);

      const reports = await roleId(owner, 'reportes');
      await owner.query("INSERT INTO ad_group_role_mappings (group_dn, role_id) VALUES ('CN=Reportes,DC=x', $1)", [reports]);
      await expectFailure(owner,
        "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = 'users.create_local'",
        [reports], /administrative permissions cannot be added/);
    });
  });

  it('el rol de sistema no se borra, no se renombra y no pierde permisos', async () => {
    await inRollback(owner, async () => {
      const superadmin = await roleId(owner, 'superadmin');
      await expectFailure(owner, 'DELETE FROM roles WHERE id = $1', [superadmin], /system roles/);
      await expectFailure(owner, "UPDATE roles SET name = 'otro' WHERE id = $1", [superadmin], /system roles/);
      await expectFailure(owner, 'UPDATE roles SET is_system = false WHERE id = $1', [superadmin], /system roles/);
      await expectFailure(owner, 'DELETE FROM role_permissions WHERE role_id = $1', [superadmin], /system role cannot be removed/);
    });
  });

  it('un rol asignado a usuarios no se borra (FK restrictiva)', async () => {
    await inRollback(owner, async () => {
      const { rows } = await owner.query("INSERT INTO roles (name) VALUES ('temporal') RETURNING id");
      await owner.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [await insertAdUser(owner), rows[0].id]);
      await expectFailure(owner, 'DELETE FROM roles WHERE id = $1', [rows[0].id], /23503|foreign key/);
    });
  });

  it('los tokens se guardan como hash de 32 bytes y los de recuperación viven 30 minutos como máximo', async () => {
    await inRollback(owner, async () => {
      const userId = await insertLocalUser(owner, await insertArea(owner));
      await expectFailure(owner,
        "INSERT INTO sessions (id, user_id, expires_at) VALUES ('raw-token', $1, now() + interval '1 hour')", [userId], /23514|check/);
      await expectFailure(owner,
        `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
         VALUES (decode(repeat('ab', 32), 'hex'), $1, now() + interval '2 hours')`, [userId], /short_lived/);
      await expectFailure(owner,
        `INSERT INTO mfa_enrollment_codes (user_id, code_hash, issued_by, expires_at)
         VALUES ($1, decode(repeat('ab', 32), 'hex'), $1, now() + interval '1 hour')`, [userId], /not_self_issued/);
    });
  });
});
