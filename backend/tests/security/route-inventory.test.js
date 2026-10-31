import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { successSchema } from '../../src/core/http/response.js';
import { buildTestApp } from '../helpers/app.js';

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
      assert.ok(route.public !== (route.permission !== null), `${route.method} ${route.url} sin declaración válida`);
    }
    const publicRoutes = app.routeInventory.filter((route) => route.public).map((route) => `${route.method} ${route.url}`);
    assert.deepEqual(publicRoutes.sort(), ['GET /health/live', 'GET /health/ready', 'HEAD /health/live', 'HEAD /health/ready']);
    const permissions = app.routeInventory.filter((route) => !route.public).map((route) => route.permission);
    assert.ok(permissions.includes('permissions.view'));
    await app.close();
  });

  it('una ruta sin declaración impide arrancar', async () => {
    await assert.rejects(appWithRoute({ schema: { response } }), /debe declarar config.public: true o config.permission/);
  });

  it('una ruta pública y con permiso a la vez impide arrancar', async () => {
    await assert.rejects(appWithRoute({ config: { public: true, permission: 'users.view' }, schema: { response } }), /solo uno de los dos/);
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
      const res = await app.inject({ method: 'POST', url: '/api/v1/probe', payload: {}, headers: cookie ? { cookie } : {} });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'AUTHENTICATION_REQUIRED');
    }
    await app.close();
  });
});
