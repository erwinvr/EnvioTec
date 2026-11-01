import { STAGES } from '../auth/stage.js';

const PERMISSION_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const INPUT_SCHEMAS = ['body', 'querystring', 'params', 'headers'];

// Every route must declare exactly one of:
//   config.public: true                     no session required
//   config.permission: '<resource>.<action>' a permission from the catalog
//   config.authenticated: true              any signed-in user, acting on
//                                           their own account (ADR-018)
// plus a response schema, and its input schemas must reject unknown
// properties. config.stages optionally lists the authentication stages the
// route accepts (default: only 'full'). A route that does not comply stops
// the application from starting (deny by default, A6). Enforcement on each
// request lives in core/authorization/authorization.js.
export function assertRouteDeclaration(route, knownPermissions) {
  const name = `${route.method} ${route.url}`;
  const config = route.config ?? {};
  const isPublic = config.public === true;
  const hasPermission = typeof config.permission === 'string';
  const isAuthenticated = config.authenticated === true;

  if ([isPublic, hasPermission, isAuthenticated].filter(Boolean).length !== 1) {
    throw new Error(`Ruta ${name}: debe declarar config.public: true, config.permission o config.authenticated: true, y solo uno de ellos`);
  }
  if (hasPermission && !PERMISSION_PATTERN.test(config.permission)) {
    throw new Error(`Ruta ${name}: el permiso "${config.permission}" no tiene el formato <recurso>.<acción>`);
  }
  if (hasPermission && !knownPermissions.has(config.permission)) {
    throw new Error(`Ruta ${name}: el permiso "${config.permission}" no existe en el catálogo`);
  }
  if (config.stages !== undefined) {
    const valid = !isPublic && Array.isArray(config.stages) && config.stages.length > 0
      && config.stages.every((stage) => STAGES.includes(stage));
    if (!valid) throw new Error(`Ruta ${name}: config.stages debe ser una lista de etapas válidas en una ruta con sesión`);
    if (hasPermission && !(config.stages.length === 1 && config.stages[0] === 'full')) {
      throw new Error(`Ruta ${name}: una ruta con permiso solo admite la etapa full`);
    }
  }
  if (!route.schema?.response) {
    throw new Error(`Ruta ${name}: debe declarar schema.response`);
  }
  for (const part of INPUT_SCHEMAS) {
    const schema = route.schema[part];
    if (schema && part !== 'headers' && schema.additionalProperties !== false) {
      throw new Error(`Ruta ${name}: schema.${part} debe declarar additionalProperties: false`);
    }
  }
}

export function registerRouteGuard(app, { knownPermissions }) {
  const inventory = [];
  app.decorate('routeInventory', inventory);

  app.addHook('onRoute', (route) => {
    assertRouteDeclaration(route, knownPermissions);
    inventory.push({
      method: route.method,
      url: route.url,
      public: route.config.public === true,
      authenticated: route.config.authenticated === true,
      permission: route.config.permission ?? null,
      stages: route.config.public === true ? [] : (route.config.stages ?? ['full']),
    });
  });
}
