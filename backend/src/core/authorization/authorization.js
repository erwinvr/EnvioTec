import { readCookie, hashToken, isWellFormedToken, SESSION_COOKIE } from '../auth/session-token.js';
import { AuthenticationError, AuthorizationError } from '../errors/errors.js';

// Authentication and authorization of every non-public route (A6):
//   no valid session            -> 401
//   session without permission  -> 403
// The route's permission comes from config.permission (see route-guard.js).
// Effective permissions are loaded on every request, so role changes apply
// immediately.
export function registerAuthorization(app, { sessionRepository, idleTimeoutMinutes }) {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    if (request.is404 || request.routeOptions.config?.public === true) return;

    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!isWellFormedToken(token)) throw new AuthenticationError();

    const tokenHash = hashToken(token);
    const session = await sessionRepository.findValidSession(tokenHash, idleTimeoutMinutes);
    if (!session) throw new AuthenticationError();

    const permissions = await sessionRepository.findEffectivePermissions(session.user_id);
    request.auth = {
      sessionHash: tokenHash,
      user: {
        id: session.user_id,
        username: session.username,
        authSource: session.auth_source,
        areaId: session.area_id,
      },
      permissions,
    };

    const required = request.routeOptions.config.permission;
    if (!permissions.has(required)) {
      // The audit event for every 403 (A7) is added with the audit service in phase 4.
      request.log.warn({ userId: session.user_id, permission: required }, 'authorization denied');
      throw new AuthorizationError();
    }

    await sessionRepository.touchSession(tokenHash);
  });
}

export function hasPermission(request, code) {
  return request.auth?.permissions.has(code) === true;
}
