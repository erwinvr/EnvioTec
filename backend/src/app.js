import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { createAuditService } from './core/audit/audit.service.js';
import { createAdProvider } from './core/auth/providers/ad.provider.js';
import { createSessionRepository } from './core/auth/session.repository.js';
import { createMfaPolicy } from './core/auth/stage.js';
import { registerAuthorization } from './core/authorization/authorization.js';
import { errorHandler, notFoundHandler } from './core/errors/error-handler.js';
import { ServiceUnavailableError } from './core/errors/errors.js';
import { createFileStore } from './core/files/storage.js';
import { registerRouteGuard } from './core/http/route-guard.js';
import { createMailer } from './core/mail/mailer.js';
import { registerOriginCheck } from './core/security/csrf.js';
import { createRateLimiter } from './core/security/rate-limiter.js';
import { registerResponseHeaders } from './core/security/response-headers.js';
import { areasRoutes } from './modules/areas/areas.routes.js';
import { auditLogsRoutes } from './modules/audit-logs/audit-logs.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { createAuthServices } from './modules/auth/auth.services.js';
import { campaignsRoutes } from './modules/campaigns/campaigns.routes.js';
import { contactsRoutes } from './modules/contacts/contacts.routes.js';
import { directoryRoutes } from './modules/directory/directory.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { PERMISSION_CATALOG, PERMISSION_CODES } from './modules/permission-catalog.js';
import { permissionsRoutes } from './modules/permissions/permissions.routes.js';
import { quotasRoutes } from './modules/quotas/quotas.routes.js';
import { rolesRoutes } from './modules/roles/roles.routes.js';
import { sendersRoutes } from './modules/senders/senders.routes.js';
import { suppressionsRoutes } from './modules/suppressions/suppressions.routes.js';
import { templatesRoutes } from './modules/templates/templates.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';

const BODY_LIMIT_BYTES = 1024 * 1024;

// Used when no queue is wired (unit tests): uploads fail closed.
const unavailableQueue = {
  async add() {
    throw new ServiceUnavailableError();
  },
};
const REQUEST_TIMEOUT_MS = 30000;

// Builds the application without listening, so tests can use app.inject().
// `db` is the PostgreSQL pool (app_runtime), `redis` the Redis client and
// `checks` the readiness checks for external dependencies. `mailer` and
// `adClientFactory` let tests replace Mandrill and the LDAP connection.
// `extraPlugins` are registered after the modules and go through the same
// route guard; tests use them to exercise the core with their own routes.
export async function buildApp({
  config, logger, db, redis, checks, mailer, adClientFactory, fileQueue = unavailableQueue, sendQueue = unavailableQueue,
  extraPlugins = [],
}) {
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

  const audit = createAuditService();
  const mfaPolicy = createMfaPolicy(PERMISSION_CATALOG);
  const ad = createAdProvider(config.ad, { clientFactory: adClientFactory, logger });
  const services = createAuthServices({
    db,
    config,
    audit,
    mfaPolicy,
    logger,
    limiter: createRateLimiter(redis),
    ad,
    mailer: mailer ?? createMailer(config.mail, logger),
  });

  registerRouteGuard(app, { knownPermissions: PERMISSION_CODES });
  registerOriginCheck(app, { appOrigin: config.security.appOrigin });
  registerAuthorization(app, {
    sessionRepository: createSessionRepository(db),
    idleTimeoutMinutes: config.session.idleTimeoutMin,
    csrfSecret: config.security.csrfSecret,
    mfaPolicy,
    audit,
    db,
  });
  registerResponseHeaders(app);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(healthRoutes, { checks });
  await app.register(authRoutes, { services });
  await app.register(usersRoutes, { db, audit, config, services });
  await app.register(areasRoutes, { db, audit });
  await app.register(rolesRoutes, { db, audit });
  await app.register(directoryRoutes, { db, ad, audit });
  await app.register(settingsRoutes, { db, audit });
  await app.register(sendersRoutes, { db, audit });
  await app.register(quotasRoutes, { db, audit });
  const store = createFileStore(config.files.dir);
  await app.register(contactsRoutes, { db, audit, store, fileQueue });
  await app.register(templatesRoutes, { db, audit, store, fileQueue });
  await app.register(campaignsRoutes, { db, audit, store, fileQueue, sendQueue });
  await app.register(suppressionsRoutes, { db, audit });
  await app.register(permissionsRoutes, { db });
  await app.register(auditLogsRoutes, { db, audit });
  for (const plugin of extraPlugins) await app.register(plugin);

  await app.ready();
  return app;
}
