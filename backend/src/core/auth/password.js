import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Argon2id with the native implementation of Node.js (ADR-016). Hashes are
// stored in the PHC string format so the parameters travel with each hash:
//   $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>   (base64, no padding)

const argon2Async = promisify(argon2);
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;
// Upper bound of the input, so a huge password cannot be used for DoS.
export const MAX_PASSWORD_BYTES = 1024;

export const DEFAULT_ARGON2_PARAMS = Object.freeze({ memoryKib: 19456, iterations: 2, parallelism: 1 });

const PHC_PATTERN = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

async function derive(password, salt, { memoryKib, iterations, parallelism }, tagLength) {
  return argon2Async('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    parallelism,
    tagLength,
    memory: memoryKib,
    passes: iterations,
  });
}

function assertPasswordInput(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new TypeError('password must be a string of at most 1024 bytes');
  }
}

export async function hashPassword(password, params = DEFAULT_ARGON2_PARAMS) {
  assertPasswordInput(password);
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, params, TAG_BYTES);
  const encode = (buffer) => buffer.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=${VERSION}$m=${params.memoryKib},t=${params.iterations},p=${params.parallelism}$${encode(salt)}$${encode(hash)}`;
}

// Returns { valid, needsRehash }. needsRehash is true when the stored hash
// was made with parameters different from the current ones (A5: rehash on
// login when the parameters change).
export async function verifyPassword(storedHash, password, currentParams = DEFAULT_ARGON2_PARAMS) {
  assertPasswordInput(password);
  const match = PHC_PATTERN.exec(storedHash ?? '');
  if (!match) return { valid: false, needsRehash: false };

  const params = { memoryKib: Number(match[1]), iterations: Number(match[2]), parallelism: Number(match[3]) };
  const salt = Buffer.from(match[4], 'base64');
  const expected = Buffer.from(match[5], 'base64');
  if (salt.length < SALT_BYTES || expected.length < TAG_BYTES) return { valid: false, needsRehash: false };

  const actual = await derive(password, salt, params, expected.length);
  const valid = timingSafeEqual(actual, expected);
  const needsRehash = valid && (
    params.memoryKib !== currentParams.memoryKib
    || params.iterations !== currentParams.iterations
    || params.parallelism !== currentParams.parallelism
  );
  return { valid, needsRehash };
}
