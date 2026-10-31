import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { createSessionRepository } from './core/auth/session.repository.js';
import { registerAuthorization } from './core/authorization/authorization.js';
import { errorHandler, notFoundHandler } from './core/errors/error-handler.js';
import { registerRouteGuard } from './core/http/route-guard.js';
import { registerResponseHeaders } from './core/security/response-headers.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { PERMISSION_CODES } from './modules/permission-catalog.js';
import { permissionsRoutes } from './modules/permissions/permissions.routes.js';

const BODY_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

// Builds the application without listening, so tests can use app.inject().
// `db` is the PostgreSQL pool (app_runtime) and `checks` the readiness checks
// for external dependencies. `extraPlugins` are registered after the modules
// and go through the same route guard; tests use them to exercise the core
// with their own routes.
export async function buildApp({ config, logger, db, checks, extraPlugins = [] }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    trustProxy: config.security.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    return503OnClosing: true,
    ajv: {
      // Reject unknown properties instead of silently removing them.
      customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true },
    },
  });

  registerRouteGuard(app, { knownPermissions: PERMISSION_CODES });
  registerAuthorization(app, {
    sessionRepository: createSessionRepository(db),
    idleTimeoutMinutes: config.session.idleTimeoutMin,
  });
  registerResponseHeaders(app);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(healthRoutes, { checks });
  await app.register(permissionsRoutes, { db });
  for (const plugin of extraPlugins) await app.register(plugin);

  await app.ready();
  return app;
}
