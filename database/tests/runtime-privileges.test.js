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

  it('append_audit_log encadena cada registro con el anterior y su hash se puede recalcular', async () => {
    await inRollback(runtime, async () => {
      const append = (action) => runtime.query(
        "SELECT append_audit_log('system', NULL, NULL, $1, 'test', '1', 'success', '10.0.0.1', 'ua', 'req', '{\"k\": 1}')",
        [action],
      );
      await append('test.first');
      await append('test.second');
      const { rows } = await runtime.query(
        `SELECT action, hash, prev_hash,
                hash = audit_log_canonical(id, occurred_at, actor_type, actor_user_id, actor_session_id, action,
                         resource_type, resource_id, result, ip, user_agent, request_id, metadata, prev_hash) AS valid
           FROM audit_logs ORDER BY seq DESC LIMIT 2`,
      );
      assert.equal(rows[0].action, 'test.second');
      assert.ok(rows[0].prev_hash.equals(rows[1].hash));
      assert.ok(rows[0].valid && rows[1].valid);
    });
  });

  it('un cambio en cualquier campo de un registro rompe su hash', async () => {
    const { rows } = await runtime.query(
      `SELECT audit_log_canonical('01900000-0000-7000-8000-000000000000', '2026-01-01T00:00:00Z', 'system', NULL, NULL, 'a.b', NULL, NULL, 'success', NULL,
                                  NULL, NULL, '{}', NULL) AS h1`,
    );
    const { rows: other } = await runtime.query(
      `SELECT audit_log_canonical('01900000-0000-7000-8000-000000000000', '2026-01-01T00:00:00Z', 'system', NULL, NULL, 'a.b', NULL, NULL, 'failure', NULL,
                                  NULL, NULL, '{}', NULL) AS h2`,
    );
    assert.ok(!rows[0].h1.equals(other[0].h2));
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
