import { readFileSync } from 'node:fs';

// Password policy (A5, NIST SP 800-63B): length 12 to 128, no composition
// rules, no forced expiry; rejects common passwords, trivial variations of
// them and passwords built from the account's own data.

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;
const MIN_DISTINCT_CHARS = 5;
const CONTEXT_WORDS = ['enviotec'];

const COMMON_PASSWORDS = new Set(
  readFileSync(new URL('./data/common-passwords.txt', import.meta.url), 'utf8').split('\n').filter(Boolean),
);

// Returns a list of rule codes the password breaks; an empty list means valid.
export function checkPassword(password, { username, email } = {}) {
  if (typeof password !== 'string') return ['invalid'];
  const length = [...password].length;
  if (length < MIN_LENGTH) return ['too_short'];
  if (length > MAX_LENGTH) return ['too_long'];

  const problems = [];
  const lower = password.toLowerCase();
  // "Summer2026!!" and "!!password1234" are as weak as the word they wrap.
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (COMMON_PASSWORDS.has(lower) || (core.length >= 4 && COMMON_PASSWORDS.has(core))) problems.push('common');

  if (new Set(lower).size < MIN_DISTINCT_CHARS) problems.push('repetitive');

  const context = [...CONTEXT_WORDS, username, email?.split('@')[0]]
    .filter((word) => typeof word === 'string' && word.length >= 3)
    .map((word) => word.toLowerCase());
  if (context.some((word) => lower.includes(word))) problems.push('contains_account_data');

  return problems;
}
