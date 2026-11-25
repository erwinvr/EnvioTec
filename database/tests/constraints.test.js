// Database-level guards that do not depend on the application (defense in
// depth). Run with the owner login, which has every table privilege: the
// guards must hold even then.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  appendAudit, connect, expectFailure, failsWith, inRollback, insertAdUser, insertArea, insertLocalUser, roleId,
} from './helpers.js';

const HASH = 'CONVERT(varbinary(32), REPLICATE(\'ab\', 32), 2)';

describe('restricciones y triggers de la base de datos', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner.end());

  it('la auditoría es append-only incluso para el dueño de la tabla', async () => {
    const withEvent = (sql) => failsWith(owner, /append-only|42501/, async (tx) => {
      await appendAudit(tx, 'test.event');
      await tx.query(sql);
    });
    await withEvent("UPDATE audit_logs SET result = 'failure'");
    await withEvent('DELETE FROM audit_logs');
  });

  it('existen las particiones mensuales de auditoría del mes actual en adelante', async () => {
    const { rows } = await owner.query(
      `SELECT COUNT(*) AS n FROM sys.partition_range_values v JOIN sys.partition_functions f ON f.function_id = v.function_id
        WHERE f.name = 'pf_audit_logs' AND CAST(v.value AS datetime2(3)) >= DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1)`,
    );
    assert.ok(rows[0].n >= 13);
    await inRollback(owner, async (tx) => {
      const { rows: created } = await tx.query("EXEC dbo.create_monthly_partitions @table = 'audit_logs', @months_ahead = 12");
      assert.equal(created[0].created, 0, 'el procedimiento es idempotente');
    });
    await expectFailure(owner, "EXEC dbo.create_monthly_partitions @table = 'users', @months_ahead = 12", [], /not partitioned/);
  });

  it('cada cuenta tiene un único origen con sus campos coherentes', async () => {
    await expectFailure(owner,
      `INSERT INTO users (username, email, display_name, auth_source, password_hash, ad_object_guid)
       VALUES ('ad.pw', 'ad.pw@example.test', 'x', 'ad', 'hash', NEWID())`, [], /users_auth_source_fields/);
    await expectFailure(owner,
      `INSERT INTO users (username, email, display_name, auth_source, password_hash, expires_at)
       VALUES ('local.noarea', 'l@example.test', 'x', 'local', 'hash', DATEADD(day, 1, SYSUTCDATETIME()))`, [], /users_auth_source_fields/);
    await failsWith(owner, /users_local_expiry/, async (tx) => tx.query(
      `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id)
       VALUES ('local.noexp', 'l2@example.test', 'x', 'local', 'hash', $1)`, [await insertArea(tx)],
    ));
    await expectFailure(owner,
      `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid, is_emergency)
       VALUES ('ad.em', 'ad.em@example.test', 'x', 'ad', NEWID(), 1)`, [], /users_emergency_is_local/);
    await failsWith(owner, /authentication source/, async (tx) => {
      const userId = await insertLocalUser(tx, await insertArea(tx), 'origin');
      // The other fields become those of an AD account, so only the guard can object.
      await tx.query(
        "UPDATE users SET auth_source = 'ad', password_hash = NULL, ad_object_guid = NEWID(), expires_at = NULL WHERE id = $1",
        [userId],
      );
    });
  });

  it('usuario y email son únicos sin distinguir mayúsculas, entre ambos orígenes', async () => {
    const withLocal = (pattern, sql) => failsWith(owner, pattern, async (tx) => {
      await insertLocalUser(tx, await insertArea(tx), 'dup');
      await tx.query(sql);
    });
    await withLocal(/users_username_key/, `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid)
       VALUES ('LOCAL.DUP', 'otro@example.test', 'x', 'ad', NEWID())`);
    await withLocal(/users_email_key/, `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid)
       VALUES ('otro', 'Local.Dup@Example.Test', 'x', 'ad', NEWID())`);
  });

  it('un rol administrativo no se asigna a una cuenta de AD ni desde un grupo de AD (ADR-007)', async () => {
    const admin = await roleId(owner, 'administrador');
    const operator = await roleId(owner, 'operador');
    await failsWith(owner, /only be assigned to local accounts/, async (tx) => {
      await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [await insertAdUser(tx), admin]);
    });
    await failsWith(owner, /never from AD groups/, async (tx) => {
      const localUser = await insertLocalUser(tx, await insertArea(tx));
      await tx.query("INSERT INTO user_roles (user_id, role_id, source) VALUES ($1, $2, 'ad_group')", [localUser, admin]);
    });
    await expectFailure(owner, "INSERT INTO ad_group_role_mappings (group_dn, role_id) VALUES ('CN=Admins,DC=x', $1)", [admin], /cannot be mapped/);
    await inRollback(owner, async (tx) => {
      await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [await insertAdUser(tx), operator]);
      await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [await insertLocalUser(tx, await insertArea(tx)), admin]);
    });
  });

  it('un rol usado desde AD no puede recibir permisos administrativos', async () => {
    const operator = await roleId(owner, 'operador');
    const reports = await roleId(owner, 'reportes');
    await failsWith(owner, /administrative permissions cannot be added/, async (tx) => {
      await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [await insertAdUser(tx), operator]);
      await tx.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = 'roles.assign'", [operator]);
    });
    await failsWith(owner, /administrative permissions cannot be added/, async (tx) => {
      await tx.query("INSERT INTO ad_group_role_mappings (group_dn, role_id) VALUES ('CN=Reportes,DC=x', $1)", [reports]);
      await tx.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = 'users.create_local'", [reports]);
    });
  });

  it('el rol de sistema no se borra, no se renombra y no pierde permisos', async () => {
    const superadmin = await roleId(owner, 'superadmin');
    await expectFailure(owner, 'DELETE FROM role_permissions WHERE role_id = $1', [superadmin], /system role cannot be removed/);
    await expectFailure(owner, "UPDATE roles SET name = 'otro' WHERE id = $1", [superadmin], /system roles/);
    await expectFailure(owner, 'UPDATE roles SET is_system = 0 WHERE id = $1', [superadmin], /system roles/);
    // Its permissions go first (FK); the guard of role_permissions stops that.
    await expectFailure(owner, 'DELETE FROM roles WHERE id = $1', [superadmin], /system roles|23503|REFERENCE/);
  });

  it('un rol asignado a usuarios no se borra (FK restrictiva)', async () => {
    await failsWith(owner, /23503|REFERENCE/, async (tx) => {
      const { rows } = await tx.query(
        "DECLARE @out TABLE (id uniqueidentifier); INSERT INTO roles (name) OUTPUT inserted.id INTO @out VALUES ('temporal'); SELECT id FROM @out;",
      );
      await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [await insertAdUser(tx), rows[0].id]);
      await tx.query('DELETE FROM roles WHERE id = $1', [rows[0].id]);
    });
  });

  it('los tokens se guardan como hash de 32 bytes y los de recuperación viven 30 minutos como máximo', async () => {
    const withUser = (pattern, sql) => failsWith(owner, pattern, async (tx) => {
      await tx.query(sql, [await insertLocalUser(tx, await insertArea(tx))]);
    });
    await withUser(/23514|CHECK/, "INSERT INTO sessions (id, user_id, expires_at) VALUES (CAST('raw-token' AS varbinary(32)), $1, DATEADD(hour, 1, SYSUTCDATETIME()))");
    await withUser(/short_lived/, `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
       VALUES (${HASH}, $1, DATEADD(hour, 2, SYSUTCDATETIME()))`);
    await withUser(/not_self_issued/, `INSERT INTO mfa_enrollment_codes (user_id, code_hash, issued_by, expires_at)
       VALUES ($1, ${HASH}, $1, DATEADD(hour, 1, SYSUTCDATETIME()))`);
  });

  it('el hash de una supresión es siempre el de su dirección', async () => {
    await expectFailure(owner,
      `INSERT INTO suppressions (email_hash, email, reason, source) VALUES (${HASH}, 'otra@example.test', 'manual', 'manual')`,
      [], /suppressions_hash_matches_email/);
  });
});
