import { Redis } from 'ioredis';

const CONNECT_TIMEOUT_MS = 5000;

// The client connects explicitly (lazyConnect) so that startup fails fast if
// Redis is unreachable. The ready check and connection names are disabled:
// INFO and CLIENT are dangerous commands and the Redis ACL denies them.
export function createRedisClient(redisConfig, logger) {
  const client = new Redis(redisConfig.url, {
    lazyConnect: true,
    enableReadyCheck: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  client.on('error', (error) => logger.warn({ errorCode: error.code, errorMessage: error.message }, 'redis error'));
  return client;
}
