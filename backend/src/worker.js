// Background worker. In phase 1 it only validates its configuration, checks
// its dependencies and shuts down cleanly; queues are added with BullMQ in
// the phases that need them (ADR-003).
import { loadConfigOrExit } from './core/config/load-or-exit.js';
import { createPool } from './core/db/pool.js';
import { onShutdownSignal } from './core/lifecycle/shutdown.js';
import { createLogger } from './core/logging/logger.js';
import { createRedisClient } from './core/redis/client.js';

const config = loadConfigOrExit('worker');
const logger = createLogger(config, { service: 'worker' });

const pool = createPool(config.database, logger, 'enviotec-worker');
const redis = createRedisClient(config.redis, logger);
await redis.connect();
await pool.query('SELECT 1');

onShutdownSignal(logger, async () => {
  await Promise.allSettled([pool.end(), redis.quit()]);
});

logger.info('worker ready');
