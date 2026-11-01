import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/errors.js';

// CSRF protection (A8): SameSite=Strict cookie, plus a synchronizer token
// bound to the session (HMAC of the session hash, so nothing extra is stored),
// plus an Origin check on every state-changing request.

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class CsrfError extends AppError {
  constructor() {
    super('Solicitud rechazada por protección CSRF', { statusCode: 403, code: 'CSRF_REJECTED' });
  }
}

export function isSafeMethod(method) {
  return SAFE_METHODS.has(method);
}

export function deriveCsrfToken(secret, sessionHash) {
  return createHmac('sha256', secret).update(sessionHash).digest('base64url');
}

export function isValidCsrfToken(secret, sessionHash, candidate) {
  if (typeof candidate !== 'string' || candidate.length > 100) return false;
  const expected = Buffer.from(deriveCsrfToken(secret, sessionHash));
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Rejects state-changing requests whose Origin is not the application's own,
// including public routes such as login (login CSRF). Browsers always send
// Origin on cross-origin and same-origin POST requests made with fetch.
export function registerOriginCheck(app, { appOrigin }) {
  app.addHook('onRequest', async (request) => {
    if (isSafeMethod(request.method)) return;
    if (request.headers.origin !== appOrigin) {
      request.log.warn({ origin: request.headers.origin ?? null }, 'origin rejected');
      throw new CsrfError();
    }
  });
}
