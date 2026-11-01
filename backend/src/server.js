import { buildApp } from './app.js';
import { loadConfigOrExit } from './core/config/load-or-exit.js';
import { createPool } from './core/db/pool.js';
import { onShutdownSignal } from './core/lifecycle/shutdown.js';
import { createLogger } from './core/logging/logger.js';
import { createQueue, QUEUES } from './core/queue/queues.js';
import { createRedisClient } from './core/redis/client.js';

const config = loadConfigOrExit('api');
const logger = createLogger(config, { service: 'backend' });

const pool = createPool(config.database, logger, 'enviotec-backend');
const redis = createRedisClient(config.redis, logger);
await redis.connect();

const fileQueue = createQueue(QUEUES.files, config.redis);

const app = await buildApp({
  config,
  logger,
  db: pool,
  redis,
  fileQueue,
  checks: {
    database: () => pool.query('SELECT 1'),
    redis: () => redis.ping(),
  },
});

onShutdownSignal(logger, async () => {
  await app.close();
  await Promise.allSettled([pool.end(), redis.quit(), fileQueue.close()]);
});

await app.listen({ host: '0.0.0.0', port: config.port });
