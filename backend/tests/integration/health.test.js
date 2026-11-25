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

describe('health con SQL Server y Redis reales', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let app;
  let pool;
  let redis;
  let config;

  before(async () => {
    config = loadConfig(process.env);
    const logger = pino({ level: 'silent' });
    pool = await createPool(config.database, logger, 'enviotec-tests');
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

  it('el login de la app solo es miembro de app_runtime: ni dueño de la base ni administrador del servidor', async () => {
    const { rows } = await pool.query(
      `SELECT IS_ROLEMEMBER('app_runtime') AS runtime, IS_MEMBER('db_owner') AS db_owner, IS_SRVROLEMEMBER('sysadmin') AS sysadmin,
              USER_NAME() AS name`,
    );
    assert.deepEqual([rows[0].runtime, rows[0].db_owner, rows[0].sysadmin], [1, 0, 0]);
    assert.notEqual(rows[0].name, 'dbo');
    // Without a per-login statement_timeout, the driver bounds every request.
    assert.ok(config.database.statementTimeoutMs > 0);
  });

  it('el usuario de Redis del backend no puede ejecutar comandos peligrosos', async () => {
    await assert.rejects(redis.call('FLUSHALL'), /NOPERM/);
    await assert.rejects(redis.call('CONFIG', 'GET', 'requirepass'), /NOPERM/);
  });
});
