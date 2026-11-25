import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScheduler, runExclusive } from '../../src/core/jobs/scheduler.js';
import { memoryLogger } from '../helpers/app.js';

// Database double: the application lock (sp_getapplock) is granted or not
// as told; the transaction that holds it always ends with a rollback.
function fakePool({ acquired = true } = {}) {
  const queries = [];
  return {
    queries,
    async connect() {
      return {
        async begin() { queries.push({ sql: 'BEGIN' }); },
        async query(sql, params) {
          queries.push({ sql, params });
          return { rows: [{ status: acquired ? 0 : -1 }] };
        },
        async rollback() { queries.push({ sql: 'ROLLBACK' }); },
      };
    },
  };
}

describe('programador de trabajos (ADR-020)', () => {
  it('ejecuta el trabajo al iniciar con un lock por nombre y lo libera', async () => {
    const pool = fakePool();
    const { logger, lines } = memoryLogger();
    const scheduler = createScheduler({ pool, logger });
    let runs = 0;
    await scheduler.every('prueba', 60000, async () => { runs += 1; return { ok: true }; });
    scheduler.stop();
    assert.equal(runs, 1);
    assert.equal(pool.queries[0].sql, 'BEGIN');
    assert.match(pool.queries[1].sql, /sp_getapplock[\s\S]*@LockTimeout = 0/);
    assert.deepEqual(pool.queries[1].params, ['enviotec.job.prueba']);
    assert.equal(pool.queries.at(-1).sql, 'ROLLBACK', 'el lock se libera al cerrar la transacción');
    assert.ok(lines.some((line) => line.includes('job finished')));
  });

  it('un error se registra y no detiene el worker', async () => {
    const { logger, lines } = memoryLogger();
    const scheduler = createScheduler({ pool: fakePool(), logger });
    await scheduler.every('falla', 60000, async () => { throw new Error('boom'); });
    scheduler.stop();
    assert.ok(lines.some((line) => line.includes('job failed')));
  });

  it('si otra réplica tiene el lock, la ronda se salta', async () => {
    let ran = false;
    const result = await runExclusive(fakePool({ acquired: false }), 'otro', async () => { ran = true; });
    assert.deepEqual(result, { skipped: true });
    assert.equal(ran, false);
  });
});
