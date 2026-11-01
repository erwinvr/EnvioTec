// Background worker: partition maintenance (R12), control of local accounts
// and review of AD accounts (scheduler of ADR-020), and the BullMQ consumer of
// file inspection results (ADR-003, ADR-004).
import { createAuditService } from './core/audit/audit.service.js';
import { createAdProvider } from './core/auth/providers/ad.provider.js';
import { loadConfigOrExit } from './core/config/load-or-exit.js';
import { ensurePartitions } from './core/db/partitions.js';
import { createPool } from './core/db/pool.js';
import { createScheduler } from './core/jobs/scheduler.js';
import { onShutdownSignal } from './core/lifecycle/shutdown.js';
import { createLogger } from './core/logging/logger.js';
import { createFileStore } from './core/files/storage.js';
import { createMailer } from './core/mail/mailer.js';
import { createWorker, QUEUES } from './core/queue/queues.js';
import { createRedisClient } from './core/redis/client.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import { createImportResultsHandler } from './modules/contacts/jobs/import-results.job.js';
import { createAccountValidityJob } from './modules/users/jobs/account-validity.job.js';
import { createAdReviewJob } from './modules/users/jobs/ad-review.job.js';
import { createJobsRepository } from './modules/users/jobs/jobs.repository.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const AD_REVIEW_MS = 15 * 60 * 1000;

const config = loadConfigOrExit('worker');
const logger = createLogger(config, { service: 'worker' });

const pool = createPool(config.database, logger, 'enviotec-worker');
const redis = createRedisClient(config.redis, logger);
await redis.connect();
await pool.query('SELECT 1');

const audit = createAuditService();
const repository = createJobsRepository();
const scheduler = createScheduler({ pool, logger });

await scheduler.every('partitions', DAY_MS, () => ensurePartitions(pool, logger));
await scheduler.every('account-validity', HOUR_MS, createAccountValidityJob({
  pool, repository, audit, mailer: createMailer(config.mail, logger), logger,
}));
await scheduler.every('ad-review', AD_REVIEW_MS, createAdReviewJob({
  pool, repository, authRepository: createAuthRepository(), ad: createAdProvider(config.ad, { logger }), audit, logger,
}));

// Outcomes of the isolated file inspection (ADR-004), applied with the database.
const store = createFileStore(config.files.dir);
const FILE_RESULT_HANDLERS = { contacts_csv: createImportResultsHandler({ pool, store, audit, logger }) };
const fileResults = createWorker(QUEUES.fileResults, async (job) => {
  const handler = FILE_RESULT_HANDLERS[job.data.kind];
  if (!handler) throw new Error(`unknown file kind: ${job.data.kind}`);
  await handler(job.data);
}, config.redis);
fileResults.on('failed', (job, error) => logger.error({ kind: job?.data.kind, fileId: job?.data.fileId, err: error }, 'file result failed'));

onShutdownSignal(logger, async () => {
  scheduler.stop();
  await fileResults.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
});

logger.info('worker ready');
