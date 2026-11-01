import { createHash, randomBytes } from 'node:crypto';

// Session tokens (A5, ADR-002): 256 random bits sent to the browser in a
// __Host- cookie; only their SHA-256 hash is stored in the sessions table.

export const SESSION_COOKIE = '__Host-enviotec_session';
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

// Reads one cookie from a Cookie header. Returns the first value with that
// exact name, or null.
export function readCookie(header, name) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

// Set-Cookie value for the session (A5): __Host- prefix, so the browser
// requires Secure, Path=/ and no Domain; HttpOnly and SameSite=Strict.
export function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}
