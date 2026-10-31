// Runs against the real PostgreSQL and Redis of the check environment
// (scripts/check.sh). Requires the same variables as the backend.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/core/config/index.js';
import { createPool } from '../../src/core/db/pool.js';
import { createRedisClient } from '../../src/core/redis/client.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe('health con PostgreSQL y Redis reales', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let app;
  let pool;
  let redis;

  before(async () => {
    const config = loadConfig(process.env);
    const logger = pino({ level: 'silent' });
    pool = createPool(config.database, logger, 'enviotec-tests');
    redis = createRedisClient(config.redis, logger);
    await redis.connect();
    app = await buildApp({
      config,
      logger,
      checks: { database: () => pool.query('SELECT 1'), redis: () => redis.ping() },
    });
  });

  after(async () => {
    await app.close();
    await pool.end();
    await redis.quit();
  });

  it('/health/live responde 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(res.statusCode, 200);
  });

  it('/health/ready responde 200 con la base y Redis disponibles', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true, data: { status: 'ready' } });
  });

  it('el usuario de la app no es superusuario y tiene statement_timeout', async () => {
    const { rows } = await pool.query(
      "SELECT current_user AS name, rolsuper, current_setting('statement_timeout') AS timeout FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(rows[0].name, 'app_runtime');
    assert.equal(rows[0].rolsuper, false);
    assert.notEqual(rows[0].timeout, '0');
  });

  it('el usuario de Redis del backend no puede ejecutar comandos peligrosos', async () => {
    await assert.rejects(redis.call('FLUSHALL'), /NOPERM/);
    await assert.rejects(redis.call('CONFIG', 'GET', 'requirepass'), /NOPERM/);
  });
});
