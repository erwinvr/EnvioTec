const PERMISSION_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const INPUT_SCHEMAS = ['body', 'querystring', 'params', 'headers'];

// Every route must declare exactly one of `config.public: true` or
// `config.permission: '<resource>.<action>'` with a permission that exists in
// the catalog, plus a response schema, and its input schemas must reject
// unknown properties. A route that does not comply stops the application from
// starting (deny by default, A6). The permission is enforced on each request
// by core/authorization/authorization.js.
export function assertRouteDeclaration(route, knownPermissions) {
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
  if (hasPermission && !knownPermissions.has(config.permission)) {
    throw new Error(`Ruta ${name}: el permiso "${config.permission}" no existe en el catálogo`);
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
      permission: route.config.permission ?? null,
    });
  });
}
