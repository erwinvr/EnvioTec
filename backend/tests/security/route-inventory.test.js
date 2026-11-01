import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { successSchema } from '../../src/core/http/response.js';
import { buildTestApp, ORIGIN } from '../helpers/app.js';

const response = { 200: successSchema({ type: 'object' }) };

function appWithRoute(options) {
  return buildTestApp({
    extraPlugins: [async (app) => app.post('/api/v1/probe', options, async () => ({ success: true, data: {} }))],
  });
}

describe('inventario de rutas (deny by default)', () => {
  it('todas las rutas registradas declaran permiso o son públicas', async () => {
    const app = await buildTestApp();
    assert.ok(app.routeInventory.length > 0);
    for (const route of app.routeInventory) {
      const declarations = [route.public, route.authenticated, route.permission !== null].filter(Boolean);
      assert.equal(declarations.length, 1, `${route.method} ${route.url} sin declaración válida`);
    }
    // The public surface is a closed list: a new public route must be added here on purpose.
    const publicRoutes = app.routeInventory.filter((route) => route.public).map((route) => `${route.method} ${route.url}`);
    assert.deepEqual(publicRoutes.sort(), [
      'GET /health/live', 'GET /health/ready', 'HEAD /health/live', 'HEAD /health/ready',
      'POST /api/v1/auth/login', 'POST /api/v1/auth/password/forgot', 'POST /api/v1/auth/password/reset',
    ]);
    const permissions = app.routeInventory.filter((route) => !route.public).map((route) => route.permission);
    assert.ok(permissions.includes('permissions.view'));
    await app.close();
  });

  it('una ruta sin declaración impide arrancar', async () => {
    await assert.rejects(appWithRoute({ schema: { response } }), /debe declarar config.public: true, config.permission o config.authenticated/);
  });

  it('una ruta pública y con permiso a la vez impide arrancar', async () => {
    await assert.rejects(appWithRoute({ config: { public: true, permission: 'users.view' }, schema: { response } }), /solo uno de ellos/);
  });

  it('un permiso con formato inválido impide arrancar', async () => {
    await assert.rejects(appWithRoute({ config: { permission: 'Users-View' }, schema: { response } }), /formato <recurso>.<acción>/);
  });

  it('un permiso que no existe en el catálogo impide arrancar', async () => {
    await assert.rejects(appWithRoute({ config: { permission: 'users.create' }, schema: { response } }), /no existe en el catálogo/);
  });

  it('una ruta sin schema de respuesta impide arrancar', async () => {
    await assert.rejects(appWithRoute({ config: { permission: 'users.view' } }), /schema.response/);
  });

  it('un body que admite propiedades desconocidas impide arrancar (mass assignment)', async () => {
    await assert.rejects(
      appWithRoute({ config: { permission: 'users.update' }, schema: { body: { type: 'object' }, response } }),
      /schema.body debe declarar additionalProperties: false/,
    );
  });

  it('una ruta protegida responde 401 sin una sesión válida', async () => {
    const app = await appWithRoute({ config: { permission: 'users.update' }, schema: { response } });
    for (const cookie of [undefined, '__Host-enviotec_session=corto', `__Host-enviotec_session=${'a'.repeat(43)}`]) {
      const headers = { origin: ORIGIN, ...(cookie ? { cookie } : {}) };
      const res = await app.inject({ method: 'POST', url: '/api/v1/probe', payload: {}, headers });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'AUTHENTICATION_REQUIRED');
    }
    await app.close();
  });

  it('config.stages solo admite etapas válidas y no se combina con un permiso', async () => {
    await assert.rejects(appWithRoute({ config: { authenticated: true, stages: ['otra'] }, schema: { response } }), /config.stages/);
    await assert.rejects(appWithRoute({ config: { public: true, stages: ['full'] }, schema: { response } }), /config.stages/);
    await assert.rejects(
      appWithRoute({ config: { permission: 'users.view', stages: ['mfa_verify'] }, schema: { response } }),
      /solo admite la etapa full/,
    );
  });

  it('un POST sin el Origin de la aplicación se rechaza antes de cualquier otro control (CSRF)', async () => {
    const app = await buildTestApp();
    for (const origin of [undefined, 'https://atacante.test', 'null', 'https://enviotec.test.atacante.test']) {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ana', password: 'x' },
        headers: origin ? { origin } : {},
      });
      assert.equal(res.statusCode, 403, `origin ${origin}`);
      assert.equal(res.json().error.code, 'CSRF_REJECTED');
    }
    await app.close();
  });
});
