// Background worker. Today it keeps the monthly partitions ahead (R12);
// queues are added with BullMQ in the phases that need them (ADR-003).
import { loadConfigOrExit } from './core/config/load-or-exit.js';
import { ensurePartitions } from './core/db/partitions.js';
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

// Daily, and once at startup. Safe with several replicas: creating a
// partition that already exists is a no-op.
const DAY_MS = 24 * 60 * 60 * 1000;
const maintain = () => ensurePartitions(pool, logger).catch((error) => logger.error({ err: error }, 'partition maintenance failed'));
await maintain();
const timer = setInterval(maintain, DAY_MS);

onShutdownSignal(logger, async () => {
  clearInterval(timer);
  await Promise.allSettled([pool.end(), redis.quit()]);
});

logger.info('worker ready');
