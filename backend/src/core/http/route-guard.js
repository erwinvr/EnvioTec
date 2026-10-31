import { AuthenticationError } from '../errors/errors.js';

const PERMISSION_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const INPUT_SCHEMAS = ['body', 'querystring', 'params', 'headers'];

// Every route must declare exactly one of `config.public: true` or
// `config.permission: '<resource>.<action>'`, plus a response schema, and its
// input schemas must reject unknown properties. A route that does not comply
// stops the application from starting (deny by default, A6).
export function assertRouteDeclaration(route) {
  const name = `${route.method} ${route.url}`;
  const config = route.config ?? {};
  const isPublic = config.public === true;
  const hasPermission = typeof config.permission === 'string';

  if (isPublic === hasPermission) {
    throw new Error(`Ruta ${name}: debe declarar config.public: true o config.permission, y solo uno de los dos`);
  }
  if (hasPermission && !PERMISSION_PATTERN.test(config.permission)) {
    throw new Error(`Ruta ${name}: el permiso "${config.permission}" no tiene el formato <recurso>.<acción>`);
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

export function registerRouteGuard(app) {
  const inventory = [];
  app.decorate('routeInventory', inventory);

  app.addHook('onRoute', (route) => {
    assertRouteDeclaration(route);
    inventory.push({
      method: route.method,
      url: route.url,
      public: route.config.public === true,
      permission: route.config.permission ?? null,
    });
  });

  // Until authentication exists (phase 3), any non-public route is denied.
  app.addHook('onRequest', async (request) => {
    if (request.is404 || request.routeOptions.config?.public === true) return;
    throw new AuthenticationError();
  });
}
