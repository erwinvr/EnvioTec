// Helpers for Active Directory data. Pure functions, tested on their own.

// RFC 4515 escaping of a value placed inside an LDAP filter, so user input
// cannot change the filter (LDAP injection).
export function escapeFilterValue(value) {
  let output = '';
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte);
    output += byte < 0x20 || byte > 0x7e || '*()\\'.includes(char)
      ? `\\${byte.toString(16).padStart(2, '0')}`
      : char;
  }
  return output;
}

// objectGUID is a 16-byte Microsoft GUID: the first three groups are
// little-endian. Returns the canonical UUID string, or null.
export function guidToUuid(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 16) return null;
  const hex = (start, end, reverse) => {
    const part = Buffer.from(buffer.subarray(start, end));
    return (reverse ? part.reverse() : part).toString('hex');
  };
  return [hex(0, 4, true), hex(4, 6, true), hex(6, 8, true), hex(8, 10, false), hex(10, 16, false)].join('-');
}

const ACCOUNT_DISABLED = 0x2;
// accountExpires: 100-ns intervals since 1601-01-01; 0 and 2^63-1 mean never.
const FILETIME_EPOCH_OFFSET_MS = 11644473600000n;
const NEVER = new Set(['0', '9223372036854775807']);

export function isAccountDisabled(userAccountControl) {
  const flags = Number.parseInt(userAccountControl, 10);
  return !Number.isInteger(flags) || (flags & ACCOUNT_DISABLED) !== 0;
}

export function isAccountExpired(accountExpires, nowMs = Date.now()) {
  if (accountExpires === undefined || accountExpires === null || accountExpires === '' || NEVER.has(String(accountExpires))) {
    return false;
  }
  if (!/^\d+$/.test(String(accountExpires))) return true;
  const expiresMs = BigInt(accountExpires) / 10000n - FILETIME_EPOCH_OFFSET_MS;
  return expiresMs <= BigInt(nowMs);
}

// Returns the first value of an attribute as a string (ldapts may return a
// string or an array).
export function firstValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  if (value === undefined || value === null) return null;
  return String(value);
}
