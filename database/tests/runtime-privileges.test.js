// Least privilege of the runtime login (A4, A7, ADR-032).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { appendAudit, connect, expectFailure, failsWith, inRollback } from './helpers.js';

const CANONICAL = (result) => `SELECT dbo.audit_log_canonical('01900000-0000-7000-8000-000000000000', '2026-01-01T00:00:00',
  'system', NULL, NULL, 'a.b', NULL, NULL, '${result}', NULL, NULL, NULL, N'{}', NULL) AS h`;

describe('privilegios del login de ejecución (app_runtime)', () => {
  let runtime;
  before(async () => {
    runtime = await connect('runtime');
  });
  after(() => runtime.end());

  it('no es administrador del servidor ni dueño de la base, y no es dueño de ningún objeto', async () => {
    const { rows } = await runtime.query(
      `SELECT IS_SRVROLEMEMBER('sysadmin') AS sysadmin, IS_MEMBER('db_owner') AS db_owner, IS_MEMBER('db_ddladmin') AS ddladmin,
              IS_ROLEMEMBER('app_runtime') AS runtime,
              (SELECT COUNT(*) FROM sys.objects o WHERE o.principal_id = DATABASE_PRINCIPAL_ID()) AS owned`,
    );
    assert.deepEqual(rows[0], { sysadmin: 0, db_owner: 0, ddladmin: 0, runtime: 1, owned: 0 });
  });

  it('escribe auditoría solo con append_audit_log y la puede leer', async () => {
    await inRollback(runtime, async (tx) => {
      await appendAudit(tx, 'test.event');
      const { rows } = await tx.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'test.event'");
      assert.ok(rows[0].n >= 1);
    });
    await expectFailure(runtime,
      "INSERT INTO audit_logs (id, actor_type, action, result, hash) VALUES (NEWID(), 'system', 'test.direct', 'success', 0x00)",
      [], /42501|permission was denied/);
  });

  it('no puede modificar, borrar ni vaciar la auditoría', async () => {
    for (const sql of ["UPDATE audit_logs SET result = 'failure'", 'DELETE FROM audit_logs', 'TRUNCATE TABLE audit_logs']) {
      await failsWith(runtime, /42501|permission|does not exist/, async (tx) => {
        await appendAudit(tx, 'test.event');
        await tx.query(sql);
      });
    }
  });

  it('append_audit_log encadena cada registro con el anterior y su hash se puede recalcular', async () => {
    await inRollback(runtime, async (tx) => {
      await appendAudit(tx, 'test.first', { metadata: '{"k":1}', ip: '10.0.0.1' });
      await appendAudit(tx, 'test.second');
      const { rows } = await tx.query(
        `SELECT TOP (2) action, hash, prev_hash,
                CAST(CASE WHEN hash = dbo.audit_log_canonical(id, occurred_at, actor_type, actor_user_id, actor_session_id, action,
                         resource_type, resource_id, result, ip, user_agent, request_id, metadata, prev_hash) THEN 1 ELSE 0 END AS bit) AS valid
           FROM audit_logs ORDER BY seq DESC`,
      );
      assert.equal(rows[0].action, 'test.second');
      assert.ok(rows[0].prev_hash.equals(rows[1].hash));
      assert.ok(rows[0].valid && rows[1].valid);
    });
  });

  it('un cambio en cualquier campo de un registro rompe su hash', async () => {
    const { rows } = await runtime.query(CANONICAL('success'));
    const { rows: other } = await runtime.query(CANONICAL('failure'));
    assert.ok(!rows[0].h.equals(other[0].h));
  });

  it('no puede alterar el esquema', async () => {
    await expectFailure(runtime, 'CREATE TABLE intruder (id int)', [], /42501|permission denied/);
    await expectFailure(runtime, 'ALTER TABLE users ADD x int', [], /42501|permission|does not exist/);
    await expectFailure(runtime, 'DISABLE TRIGGER audit_logs_no_update ON audit_logs', [], /42501|permission|does not exist/);
    await expectFailure(runtime, 'DROP TABLE sessions', [], /42501|permission|does not exist/);
  });

  it('no puede escribir el catálogo de permisos', async () => {
    await expectFailure(runtime, "INSERT INTO permissions (code, description) VALUES ('evil.grant', 'x')", [], /42501|permission was denied/);
    await expectFailure(runtime, "UPDATE permissions SET is_administrative = 0 WHERE code = 'roles.assign'", [], /42501|permission was denied/);
  });

  it('solo puede cambiar el valor de un parámetro, no su rango', async () => {
    await inRollback(runtime, async (tx) => {
      await tx.query("UPDATE system_settings SET value = '30' WHERE [key] = 'local_account.default_validity_days'");
    });
    await expectFailure(runtime, "UPDATE system_settings SET max_value = 99999 WHERE [key] = 'local_account.max_validity_days'", [], /42501|permission was denied/);
    await expectFailure(runtime, "INSERT INTO system_settings ([key], value_type, value, description) VALUES ('x.y', 'string_list', '[]', 'x')", [], /42501|permission was denied/);
    await expectFailure(runtime, "UPDATE system_settings SET value = '9999' WHERE [key] = 'local_account.max_validity_days'", [], /23514|CHECK/);
  });

  it('no puede crear particiones por su cuenta, solo con el procedimiento', async () => {
    await expectFailure(runtime, 'ALTER PARTITION FUNCTION pf_audit_logs() SPLIT RANGE (\'2099-01-01\')', [], /42501|permission|does not exist/);
  });
});
