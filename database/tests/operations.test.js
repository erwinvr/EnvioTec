import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { decryptSecret, encryptSecret } from '../../backend/src/core/security/encryption.js';
import { revokeSessions } from '../scripts/lib/revoke-sessions.js';
import { parseKey, rotateEncryptionKey } from '../scripts/lib/rotate-key.js';
import { connect, insertArea, insertLocalUser, inRollback } from './helpers.js';

describe('rotación de DATA_ENCRYPTION_KEY', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner.end());

  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);

  async function userWithSecret(tx, key) {
    const id = await insertLocalUser(tx, await insertArea(tx));
    await tx.query('UPDATE users SET mfa_secret_encrypted = $2, mfa_enabled_at = SYSUTCDATETIME() WHERE id = $1', [id, encryptSecret(key, Buffer.from('JBSWY3DPEHPK3PXP'), `mfa:${id}`)]);
    return id;
  }

  it('vuelve a cifrar cada secreto MFA con la clave nueva y lo audita', async () => {
    await inRollback(owner, async (tx) => {
      // Only this test's secrets, all under the old key.
      await tx.query('UPDATE users SET mfa_secret_encrypted = NULL, mfa_enabled_at = NULL');
      const ids = [await userWithSecret(tx, oldKey), await userWithSecret(tx, oldKey)];
      assert.deepEqual(await rotateEncryptionKey(tx, { oldKey, newKey }), { secrets: 2 });
      for (const id of ids) {
        const { rows } = await tx.query('SELECT mfa_secret_encrypted FROM users WHERE id = $1', [id]);
        assert.equal(decryptSecret(newKey, rows[0].mfa_secret_encrypted, `mfa:${id}`).toString(), 'JBSWY3DPEHPK3PXP');
        assert.throws(() => decryptSecret(oldKey, rows[0].mfa_secret_encrypted, `mfa:${id}`));
      }
      const { rows: audit } = await tx.query("SELECT TOP (1) metadata FROM audit_logs WHERE action = 'security.key_rotation' ORDER BY seq DESC");
      assert.deepEqual(audit[0].metadata, { reencrypted: 2 });
    });
  });

  it('con un secreto que no se descifra no rota nada; claves inválidas o iguales se rechazan', async () => {
    await inRollback(owner, async (tx) => {
      await tx.query('UPDATE users SET mfa_secret_encrypted = NULL, mfa_enabled_at = NULL');
      await userWithSecret(tx, oldKey);
      await userWithSecret(tx, randomBytes(32));
      await assert.rejects(rotateEncryptionKey(tx, { oldKey, newKey }), /no se descifra con la clave actual/);
    });
    assert.throws(() => parseKey('corta', '--new'), /32 bytes/);
    assert.equal(parseKey(` ${oldKey.toString('base64')}\n`, '--old').length, 32);
    await assert.rejects(rotateEncryptionKey(owner, { oldKey, newKey: oldKey }), /igual a la actual/);
  });
});

describe('revocación masiva de sesiones', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner.end());

  it('revoca las sesiones activas (todas o de un usuario), con motivo obligatorio, y lo audita', async () => {
    await inRollback(owner, async (tx) => {
      const area = await insertArea(tx);
      const [a, b] = [await insertLocalUser(tx, area), await insertLocalUser(tx, area)];
      for (const user of [a, a, b]) {
        await tx.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, DATEADD(hour, 1, SYSUTCDATETIME()))', [randomBytes(32), user]);
      }
      assert.deepEqual(await revokeSessions(tx, { reason: 'Cuenta comprometida', userId: a }), { sessions: 2 });
      const { rows } = await tx.query(
        'SELECT user_id FROM sessions WHERE user_id IN (SELECT value FROM OPENJSON($1)) AND revoked_at IS NULL', [[a, b]],
      );
      assert.deepEqual(rows.map((r) => r.user_id), [b]);
      const all = await revokeSessions(tx, { reason: 'Incidente de prueba' });
      assert.ok(all.sessions >= 1);
      const { rows: audit } = await tx.query("SELECT TOP (2) metadata FROM audit_logs WHERE action = 'session.mass_revoke' ORDER BY seq DESC");
      assert.deepEqual(audit.map((r) => r.metadata.reason), ['Incidente de prueba', 'Cuenta comprometida']);
      await assert.rejects(revokeSessions(tx, { reason: 'x' }), /motivo/);
    });
  });
});
