import { tryLockName } from '../db/transaction.js';

// Periodic jobs of the worker (ADR-020). Each run holds an application lock
// named after the job, in a transaction of its own that only keeps the lock
// (the job works on other connections): with several worker replicas, only
// one runs it at a time and the others skip that round. Jobs are idempotent,
// so a failed or skipped round is simply repeated on the next one.

export async function runExclusive(pool, name, fn) {
  const client = await pool.connect();
  await client.begin();
  try {
    if (!(await tryLockName(client, `enviotec.job.${name}`))) return { skipped: true };
    return await fn();
  } finally {
    await client.rollback();
  }
}

export function createScheduler({ pool, logger }) {
  const timers = [];
  return {
    // Runs fn now and then every intervalMs. Errors are logged, never thrown.
    async every(name, intervalMs, fn) {
      const tick = async () => {
        try {
          const result = await runExclusive(pool, name, fn);
          logger.info({ job: name, result }, 'job finished');
        } catch (error) {
          logger.error({ job: name, err: error }, 'job failed');
        }
      };
      await tick();
      timers.push(setInterval(tick, intervalMs));
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
  };
}
