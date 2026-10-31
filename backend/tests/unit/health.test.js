import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTestApp } from '../helpers/app.js';

describe('health (dependencias simuladas)', () => {
  it('/health/live responde 200', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true, data: { status: 'ok' } });
    await app.close();
  });

  it('/health/ready responde 503 sin revelar qué dependencia falló', async () => {
    const app = await buildTestApp({
      checks: { database: async () => { throw new Error('connection refused 10.0.0.5'); }, redis: async () => {} },
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'SERVICE_UNAVAILABLE');
    assert.ok(!res.body.includes('database'));
    assert.ok(!res.body.includes('10.0.0.5'));
    await app.close();
  });

  it('/health/ready responde 503 si una dependencia no contesta a tiempo', async () => {
    const app = await buildTestApp({
      checks: { database: () => new Promise(() => {}), redis: async () => {} },
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});
