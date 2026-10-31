import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { errorHandler, notFoundHandler } from './core/errors/error-handler.js';
import { registerRouteGuard } from './core/http/route-guard.js';
import { registerResponseHeaders } from './core/security/response-headers.js';
import { healthRoutes } from './modules/health/health.routes.js';

const BODY_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

// Builds the application without listening, so tests can use app.inject().
// `checks` are the readiness checks for external dependencies. `extraPlugins`
// are registered after the core and go through the same route guard; tests
// use them to exercise the core with their own routes.
export async function buildApp({ config, logger, checks, extraPlugins = [] }) {
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

  registerRouteGuard(app);
  registerResponseHeaders(app);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(healthRoutes, { checks });
  for (const plugin of extraPlugins) await app.register(plugin);

  await app.ready();
  return app;
}
