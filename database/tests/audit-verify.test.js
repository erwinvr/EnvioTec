import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { verifyAuditChain } from '../scripts/lib/audit-verify.js';
import { connect, inRollback } from './helpers.js';

const append = (client, action) => client.query(
  "SELECT append_audit_log('system', NULL, NULL, $1, 'test', '1', 'success', NULL, NULL, NULL, '{}') AS id",
  [action],
);

// The tamper tests disable the protection triggers as the owner inside a
// transaction that is always rolled back: they simulate someone with direct
// database access, which the chain must expose.
describe('verificación de la cadena de auditoría', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner?.end());

  it('una cadena intacta se verifica completa', async () => {
    await inRollback(owner, async () => {
      for (const action of ['test.uno', 'test.dos', 'test.tres']) await append(owner, action);
      const result = await verifyAuditChain(owner);
      assert.equal(result.problem, null);
      assert.ok(result.checked >= 3);
    });
  });

  it('detecta un registro alterado', async () => {
    await inRollback(owner, async () => {
      await append(owner, 'test.uno');
      const { rows } = await append(owner, 'test.dos');
      await append(owner, 'test.tres');
      await owner.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update');
      await owner.query("UPDATE audit_logs SET result = 'failure' WHERE id = $1", [rows[0].id]);
      const result = await verifyAuditChain(owner);
      assert.equal(result.problem.reason, 'altered');
      assert.equal(result.problem.id, rows[0].id);
    });
  });

  it('detecta un registro eliminado', async () => {
    await inRollback(owner, async () => {
      await append(owner, 'test.uno');
      const { rows: deleted } = await append(owner, 'test.dos');
      const { rows: next } = await append(owner, 'test.tres');
      await owner.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update');
      await owner.query('DELETE FROM audit_logs WHERE id = $1', [deleted[0].id]);
      const result = await verifyAuditChain(owner);
      assert.equal(result.problem.reason, 'broken_link');
      assert.equal(result.problem.id, next[0].id);
    });
  });

  it('detecta un registro insertado fuera de append_audit_log', async () => {
    await inRollback(owner, async () => {
      await append(owner, 'test.uno');
      await owner.query(
        `INSERT INTO audit_logs (actor_type, action, result, hash)
         VALUES ('system', 'test.falso', 'success', sha256('x'::bytea))`,
      );
      const result = await verifyAuditChain(owner);
      assert.notEqual(result.problem, null);
    });
  });

  it('--from verifica desde una fecha enlazando con el registro anterior', async () => {
    await inRollback(owner, async () => {
      await append(owner, 'test.uno');
      const { rows } = await owner.query('SELECT clock_timestamp() AS at');
      await append(owner, 'test.dos');
      const result = await verifyAuditChain(owner, { from: rows[0].at });
      assert.equal(result.problem, null);
      assert.equal(result.checked, 1);
    });
  });
});
