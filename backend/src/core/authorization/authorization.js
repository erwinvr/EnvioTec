import { actorFrom, auditContext } from '../audit/audit.service.js';
import { computeStage } from '../auth/stage.js';
import { readCookie, hashToken, isWellFormedToken, SESSION_COOKIE } from '../auth/session-token.js';
import { AreaWriteDeniedError, AuthenticationError, AuthorizationError } from '../errors/errors.js';
import { CSRF_HEADER, CsrfError, isSafeMethod, isValidCsrfToken } from '../security/csrf.js';

// Reauthentication is valid for 5 minutes (A5).
const REAUTH_WINDOW_MS = 5 * 60 * 1000;

// Authentication and authorization of every non-public route (A6, ADR-018):
//   no valid session                         -> 401
//   session in a stage the route does not
//   accept (MFA or password change pending)  -> 403 AUTH_STEP_REQUIRED
//   unsafe method without a valid CSRF token -> 403 CSRF_REJECTED
//   session without the route's permission   -> 403 FORBIDDEN (audited)
// Routes declare config.permission or config.authenticated (any signed-in
// user, for their own account); see route-guard.js. Effective permissions
// are loaded on every request, so role changes apply immediately.
export function registerAuthorization(app, { sessionRepository, idleTimeoutMinutes, csrfSecret, mfaPolicy, audit, db }) {
  app.decorateRequest('auth', null);

  // Every 403 is audited (A7): a change attempted outside the user's area is
  // detected in the services, after the route permission check.
  app.addHook('onError', async (request, reply, error) => {
    if (!(error instanceof AreaWriteDeniedError)) return;
    await audit.record(db, {
      actor: actorFrom(request.auth), action: 'authorization.area_deny', resourceType: error.resourceType, resourceId: error.resourceId,
      result: 'denied', context: auditContext(request), metadata: { route: `${request.method} ${request.routeOptions.url}` },
    });
  });

  app.addHook('onRequest', async (request) => {
    if (request.is404 || request.routeOptions.config?.public === true) return;

    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!isWellFormedToken(token)) throw new AuthenticationError();

    const tokenHash = hashToken(token);
    const session = await sessionRepository.findValidSession(tokenHash, idleTimeoutMinutes);
    if (!session) {
      await auditExpiration(request, tokenHash);
      throw new AuthenticationError();
    }

    const permissions = await sessionRepository.findEffectivePermissions(session.user_id);
    const mfaRequired = mfaPolicy.isRequired(permissions);
    const stage = computeStage({
      mfaEnabled: session.mfa_enabled_at !== null,
      mfaVerified: session.mfa_verified_at !== null,
      mustChangePassword: session.must_change_password,
      mfaRequired,
    });
    request.auth = {
      sessionHash: tokenHash,
      session: { createdAt: session.created_at, expiresAt: session.expires_at, reauthAt: session.reauth_at },
      user: {
        id: session.user_id,
        username: session.username,
        email: session.email,
        displayName: session.display_name,
        authSource: session.auth_source,
        areaId: session.area_id,
        mfaEnabled: session.mfa_enabled_at !== null,
      },
      stage,
      mfaRequired,
      // Permissions apply only once the session is fully authenticated.
      permissions: stage === 'full' ? permissions : new Set(),
    };

    const { config } = request.routeOptions;
    const stages = config.stages ?? ['full'];
    if (!stages.includes(stage)) {
      throw new AuthorizationError('Debe completar la autenticación', {
        code: 'AUTH_STEP_REQUIRED', details: [{ field: 'stage', code: stage }],
      });
    }

    if (!isSafeMethod(request.method) && !isValidCsrfToken(csrfSecret, tokenHash, request.headers[CSRF_HEADER])) {
      request.log.warn({ userId: session.user_id }, 'csrf token rejected');
      throw new CsrfError();
    }

    if (config.permission && !request.auth.permissions.has(config.permission)) {
      request.log.warn({ userId: session.user_id, permission: config.permission }, 'authorization denied');
      await audit.record(db, {
        actor: actorFrom(request.auth),
        action: 'authorization.deny',
        resourceType: 'route',
        resourceId: `${request.method} ${request.routeOptions.url}`,
        result: 'denied',
        context: auditContext(request),
        metadata: { permission: config.permission },
      });
      throw new AuthorizationError();
    }

    await sessionRepository.touchSession(tokenHash);
  });

  async function auditExpiration(request, tokenHash) {
    const userId = await sessionRepository.expireIfTimedOut(tokenHash, idleTimeoutMinutes);
    if (userId === null) return;
    await audit.record(db, {
      actor: { userId, sessionHash: tokenHash },
      action: 'auth.session_expire',
      resourceType: 'session',
      result: 'success',
      context: auditContext(request),
    });
  }
}

export function hasPermission(request, code) {
  return request.auth?.permissions.has(code) === true;
}

// Sensitive actions (change password, configure MFA, assign roles, disable
// users) require a password or MFA check from the last 5 minutes (A5).
export function assertRecentReauth(auth, nowMs = Date.now()) {
  const at = auth?.session.reauthAt;
  if (!at || nowMs - new Date(at).getTime() > REAUTH_WINDOW_MS) {
    throw new AuthorizationError('Confirme su identidad para continuar', { code: 'REAUTH_REQUIRED' });
  }
}
