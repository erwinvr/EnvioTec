import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238) with HMAC-SHA1, 6 digits and 30-second steps: the settings
// every authenticator app supports. Implemented natively (architecture.md §5)
// and tested with the RFC test vectors.

const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;
// One step of tolerance on each side for clock drift.
const WINDOW = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret() {
  return randomBytes(SECRET_BYTES);
}

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function hotp(secret, counter, digits = DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function timeStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

// Returns the matched time step, or null. The caller rejects a step equal to
// or lower than the last one used, so a code cannot be replayed.
export function verifyTotp(secret, code, { nowMs = Date.now() } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = timeStep(nowMs);
  const candidate = Buffer.from(code);
  let matched = null;
  // Every step in the window is checked, so timing does not reveal which one matched.
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), candidate) && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(secret, { issuer, account }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}
