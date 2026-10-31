import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { successSchema } from '../../src/core/http/response.js';
import { buildTestApp, memoryLogger } from '../helpers/app.js';

const INTERNAL_DETAIL = 'SELECT password_hash FROM users WHERE id = 1 /app/src/secret.js';

const probeRoutes = async (app) => {
  const response = { 200: successSchema({ type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } }) };
  app.get('/api/v1/boom', { config: { public: true }, schema: { response } }, async () => {
    throw new Error(INTERNAL_DETAIL);
  });
  app.get('/api/v1/leak', { config: { public: true }, schema: { response } }, async () => ({
    success: true,
    data: { id: 'u1', password_hash: '$argon2id$secret', token: 'abc' },
  }));
  app.post('/api/v1/echo', {
    config: { public: true },
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', maxLength: 10 } } },
      response,
    },
  }, async () => ({ success: true, data: { id: 'ok' } }));
};

describe('exposición de información en respuestas', () => {
  let app;
  let lines;

  before(async () => {
    const memory = memoryLogger();
    lines = memory.lines;
    app = await buildTestApp({ extraPlugins: [probeRoutes], logger: memory.logger });
  });
  after(() => app.close());

  it('un error no previsto devuelve un 500 genérico con requestId y sin detalles internos', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/boom' });
    assert.equal(res.statusCode, 500);
    const body = res.json();
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId']);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.requestId, res.headers['x-request-id']);
    assert.ok(!res.body.includes('SELECT'));
    assert.ok(!res.body.includes('/app/src'));
    assert.ok(!res.body.includes('stack'));
    assert.ok(lines.some((line) => line.includes('SELECT password_hash')), 'el detalle debe quedar en el log del servidor');
  });

  it('el schema de respuesta descarta campos no declarados', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/leak' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true, data: { id: 'u1' } });
  });

  it('rechaza propiedades desconocidas en el body con 422 sin devolver valores', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/echo', payload: { name: 'ana', status: 'active' } });
    assert.equal(res.statusCode, 422);
    assert.deepEqual(res.json().error.details, [{ field: 'status', code: 'unknown_field', location: 'body' }]);
    assert.ok(!res.body.includes('active'));
  });

  it('un JSON malformado devuelve 400 genérico', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/echo', headers: { 'content-type': 'application/json' }, payload: '{"name":',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'BAD_REQUEST');
    assert.equal(res.json().error.message, 'Solicitud inválida');
  });

  it('un body mayor al límite devuelve 413', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/echo', headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error.code, 'PAYLOAD_TOO_LARGE');
  });

  it('un tipo de contenido no admitido devuelve 415', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/echo', headers: { 'content-type': 'text/xml' }, payload: '<a/>' });
    assert.equal(res.statusCode, 415);
  });

  it('una ruta inexistente devuelve 404 con el formato estándar', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/no-existe' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
    assert.equal(res.json().success, false);
  });

  it('todas las respuestas llevan Cache-Control: no-store y un request ID generado por el servidor', async () => {
    const supplied = 'attacker-controlled-id';
    for (const url of ['/health/live', '/api/v1/boom', '/api/v1/no-existe']) {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-request-id': supplied } });
      assert.equal(res.headers['cache-control'], 'no-store', url);
      assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/, url);
      assert.notEqual(res.headers['x-request-id'], supplied, url);
    }
  });
});
