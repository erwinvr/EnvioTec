import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

// BullMQ queues (ADR-003, ADR-022). Jobs carry only IDs and non-sensitive
// parameters; business state lives in PostgreSQL. The version check is
// skipped because it needs INFO, which the Redis ACL denies to every service.
//   files          backend -> file-processor: inspect an uploaded file
//   files-results  file-processor -> worker: outcome of the inspection
//   send           backend/worker -> worker: test sends and campaign batches
// Each queue and worker owns its Redis connection and closes it with
// close(): BullMQ does not close a connection it was given.

export const QUEUES = Object.freeze({ files: 'files', fileResults: 'files-results', send: 'send' });

const DEFAULT_JOB = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

function connect(redisConfig) {
  return new Redis(redisConfig.url, { maxRetriesPerRequest: null, enableReadyCheck: false, connectTimeout: 5000 });
}

function owning(instance, connection) {
  const close = instance.close.bind(instance);
  instance.close = async () => {
    await close();
    await connection.quit().catch(() => connection.disconnect());
  };
  return instance;
}

export function createQueue(name, redisConfig) {
  const connection = connect(redisConfig);
  return owning(new Queue(name, { connection, skipVersionCheck: true, defaultJobOptions: DEFAULT_JOB }), connection);
}

export function createWorker(name, processor, redisConfig, { concurrency = 1 } = {}) {
  const connection = connect(redisConfig);
  return owning(new Worker(name, processor, { connection, skipVersionCheck: true, concurrency }), connection);
}
