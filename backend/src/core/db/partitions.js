// Monthly partitions of high-volume tables (ADR-010, R12, ADR-032). SQL Server
// keeps every row in some partition (the last one catches dates beyond the
// last boundary), so a missing month never makes an insert fail; the worker
// still keeps a year of boundaries ahead, so each month has its own
// partition, and logs an error if fewer than MIN_MONTHS_AHEAD remain.

import { lockName, withTransaction } from './transaction.js';

export const PARTITIONED_TABLES = ['audit_logs', 'message_events'];
const MONTHS_AHEAD = 12;
const MIN_MONTHS_AHEAD = 3;

// Serialized with an application lock, so two worker replicas never split
// the same partition function at once.
export async function ensurePartitions(pool, logger) {
  return withTransaction(pool, (client) => maintain(client, logger));
}

async function maintain(db, logger) {
  await lockName(db, 'enviotec.partitions');
  const report = {};
  for (const table of PARTITIONED_TABLES) {
    const { rows } = await db.query('EXEC dbo.create_monthly_partitions @table = $1, @months_ahead = $2', [table, MONTHS_AHEAD]);
    report[table] = { created: rows[0].created, ok: rows[0].ok };
    if (!rows[0].ok) {
      logger.error({ table, monthsAhead: MIN_MONTHS_AHEAD }, 'partition missing: the month will share the last partition');
    } else if (rows[0].created > 0) {
      logger.info({ table, created: rows[0].created }, 'partitions created');
    }
  }
  return report;
}
