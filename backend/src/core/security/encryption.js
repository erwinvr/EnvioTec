import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Encryption of secrets at rest (TOTP secrets) with AES-256-GCM and the key
// in DATA_ENCRYPTION_KEY (A5). Layout: version (1) | IV (12) | tag (16) |
// ciphertext. The associated data binds the ciphertext to its owner (for
// example the user ID), so it cannot be copied to another row.

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export function encryptSecret(key, plaintext, associatedData) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

// Throws if the data was altered, belongs to another owner or uses another key.
export function decryptSecret(key, payload, associatedData) {
  if (!Buffer.isBuffer(payload) || payload.length <= HEADER_BYTES || payload[0] !== VERSION) {
    throw new Error('encrypted payload has an unknown format');
  }
  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(HEADER_BYTES)), decipher.final()]);
}
