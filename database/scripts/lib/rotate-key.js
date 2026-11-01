import { decryptSecret, encryptSecret } from '../../../backend/src/core/security/encryption.js';

// Re-encrypts every secret stored with DATA_ENCRYPTION_KEY (today, the TOTP
// secrets) under a new key, in the caller's transaction: either every row
// moves to the new key or none does. A row that does not decrypt with the
// old key aborts the whole rotation (wrong key, or data altered).

export function parseKey(text, label) {
  const key = Buffer.from(String(text).trim(), 'base64');
  if (key.length !== 32) throw new Error(`${label}: debe ser una clave de 32 bytes en base64`);
  return key;
}

export async function rotateEncryptionKey(client, { oldKey, newKey }) {
  if (oldKey.equals(newKey)) throw new Error('la clave nueva es igual a la actual');
  const { rows } = await client.query('SELECT id, mfa_secret_encrypted FROM users WHERE mfa_secret_encrypted IS NOT NULL FOR UPDATE');
  for (const row of rows) {
    const aad = `mfa:${row.id}`;
    let secret;
    try {
      secret = decryptSecret(oldKey, row.mfa_secret_encrypted, aad);
    } catch {
      throw new Error(`el secreto MFA del usuario ${row.id} no se descifra con la clave actual: no se rotó nada`);
    }
    await client.query('UPDATE users SET mfa_secret_encrypted = $2 WHERE id = $1', [row.id, encryptSecret(newKey, secret, aad)]);
  }
  await client.query(
    "SELECT append_audit_log('system', NULL, NULL, 'security.key_rotation', 'data_encryption_key', NULL, 'success', NULL, NULL, NULL, jsonb_build_object('secrets', $1::int))",
    [rows.length],
  );
  return { secrets: rows.length };
}
