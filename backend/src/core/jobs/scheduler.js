// Periodic jobs of the worker (ADR-020). Each run takes a session-level
// advisory lock named after the job: with several worker replicas, only one
// runs it at a time and the others skip that round. Jobs are idempotent, so a
// failed or skipped round is simply repeated on the next one.

export async function runExclusive(pool, name, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`enviotec.job.${name}`]);
    if (!rows[0].acquired) return { skipped: true };
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`enviotec.job.${name}`]);
    }
  } finally {
    client.release();
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
