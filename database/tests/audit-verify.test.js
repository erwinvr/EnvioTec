import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { verifyAuditChain } from '../scripts/lib/audit-verify.js';
import { appendAudit as append, connect, inRollback } from './helpers.js';

const pause = () => new Promise((resolve) => { setTimeout(resolve, 20); });

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
    await inRollback(owner, async (tx) => {
      for (const action of ['test.uno', 'test.dos', 'test.tres']) await append(tx, action);
      const result = await verifyAuditChain(tx);
      assert.equal(result.problem, null);
      assert.ok(result.checked >= 3);
    });
  });

  it('detecta un registro alterado', async () => {
    await inRollback(owner, async (tx) => {
      await append(tx, 'test.uno');
      const { rows } = await append(tx, 'test.dos');
      await append(tx, 'test.tres');
      await tx.query('DISABLE TRIGGER audit_logs_no_update ON audit_logs');
      await tx.query("UPDATE audit_logs SET result = 'failure' WHERE id = $1", [rows[0].id]);
      const result = await verifyAuditChain(tx);
      assert.equal(result.problem.reason, 'altered');
      assert.equal(result.problem.id, rows[0].id);
    });
  });

  it('detecta un registro eliminado', async () => {
    await inRollback(owner, async (tx) => {
      await append(tx, 'test.uno');
      const { rows: deleted } = await append(tx, 'test.dos');
      const { rows: next } = await append(tx, 'test.tres');
      await tx.query('DISABLE TRIGGER audit_logs_no_update ON audit_logs');
      await tx.query('DELETE FROM audit_logs WHERE id = $1', [deleted[0].id]);
      const result = await verifyAuditChain(tx);
      assert.equal(result.problem.reason, 'broken_link');
      assert.equal(result.problem.id, next[0].id);
    });
  });

  it('detecta un registro insertado fuera de append_audit_log', async () => {
    await inRollback(owner, async (tx) => {
      await append(tx, 'test.uno');
      await tx.query(
        `INSERT INTO audit_logs (id, actor_type, action, result, hash)
         VALUES (NEWID(), 'system', 'test.falso', 'success', HASHBYTES('SHA2_256', 'x'))`,
      );
      const result = await verifyAuditChain(tx);
      assert.notEqual(result.problem, null);
    });
  });

  it('--from verifica desde una fecha enlazando con el registro anterior', async () => {
    await inRollback(owner, async (tx) => {
      await append(tx, 'test.uno');
      await pause();
      const { rows } = await tx.query('SELECT SYSUTCDATETIME() AS at');
      await pause();
      await append(tx, 'test.dos');
      const result = await verifyAuditChain(tx, { from: rows[0].at });
      assert.equal(result.problem, null);
      assert.equal(result.checked, 1);
    });
  });
});
