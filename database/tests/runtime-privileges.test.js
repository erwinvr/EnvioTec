// Least privilege of the app_runtime user (A4, A7).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connect, expectFailure, inRollback } from './helpers.js';

const AUDIT_ROW = `INSERT INTO audit_logs (actor_type, action, result, hash)
                   VALUES ('system', 'test.event', 'success', decode(repeat('ab', 32), 'hex'))`;

describe('privilegios de app_runtime', () => {
  let runtime;
  before(async () => {
    runtime = await connect('runtime');
  });
  after(() => runtime.end());

  it('no es superusuario ni dueño de las tablas', async () => {
    const { rows } = await runtime.query(
      `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
              (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user)::int AS owned
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    assert.deepEqual(rows[0], { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, owned: 0 });
  });

  it('puede insertar y leer auditoría', async () => {
    await inRollback(runtime, async () => {
      await runtime.query(AUDIT_ROW);
      const { rows } = await runtime.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'test.event'");
      assert.equal(rows[0].n, 1);
    });
  });

  it('no puede modificar, borrar ni vaciar la auditoría', async () => {
    await inRollback(runtime, async () => {
      await runtime.query(AUDIT_ROW);
      await expectFailure(runtime, "UPDATE audit_logs SET result = 'failure'", [], /42501|permission denied/);
      await expectFailure(runtime, 'DELETE FROM audit_logs', [], /42501|permission denied/);
      await expectFailure(runtime, 'TRUNCATE audit_logs', [], /42501|permission denied/);
    });
  });

  it('no puede alterar el esquema', async () => {
    await inRollback(runtime, async () => {
      await expectFailure(runtime, 'CREATE TABLE intruder (id int)', [], /42501|permission denied/);
      await expectFailure(runtime, 'ALTER TABLE users ADD COLUMN x int', [], /42501|must be owner/);
      await expectFailure(runtime, 'ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update', [], /42501|must be owner/);
      await expectFailure(runtime, 'DROP TABLE sessions', [], /42501|must be owner/);
    });
  });

  it('no puede escribir el catálogo de permisos', async () => {
    await inRollback(runtime, async () => {
      await expectFailure(runtime, "INSERT INTO permissions (code, description) VALUES ('evil.grant', 'x')", [], /42501|permission denied/);
      await expectFailure(runtime, "UPDATE permissions SET is_administrative = false WHERE code = 'roles.assign'", [], /42501|permission denied/);
    });
  });

  it('solo puede cambiar el valor de un parámetro, no su rango', async () => {
    await inRollback(runtime, async () => {
      await runtime.query("UPDATE system_settings SET value = '30'::jsonb WHERE key = 'local_account.default_validity_days'");
      await expectFailure(runtime, "UPDATE system_settings SET max_value = 99999 WHERE key = 'local_account.max_validity_days'", [], /42501|permission denied/);
      await expectFailure(runtime, "INSERT INTO system_settings (key, value_type, value, description) VALUES ('x.y', 'string_list', '[]', 'x')", [], /42501|permission denied/);
      await expectFailure(runtime, "UPDATE system_settings SET value = '9999'::jsonb WHERE key = 'local_account.max_validity_days'", [], /23514|check/);
    });
  });
});
