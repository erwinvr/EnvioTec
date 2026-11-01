import { hashPassword, verifyPassword } from '../password.js';

// Local accounts (Argon2id, ADR-016). `dummyVerify` runs a full Argon2
// verification against a throwaway hash, so a login for an unknown, locked
// or AD-less account takes about as long as a real one (A5: no enumeration).
export function createLocalProvider({ argon2 }) {
  let dummyHash;

  return {
    async verify(passwordHash, password) {
      return verifyPassword(passwordHash, password, argon2);
    },

    async dummyVerify(password) {
      dummyHash ??= await hashPassword('enviotec-dummy-password-not-used', argon2);
      await verifyPassword(dummyHash, password, argon2);
    },

    async hash(password) {
      return hashPassword(password, argon2);
    },
  };
}
