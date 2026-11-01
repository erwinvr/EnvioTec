// Monthly partitions of high-volume tables (ADR-010, R12). There is no
// default partition on purpose: a missing month makes the insert fail, and
// with it the audited action (fail safe). The worker keeps a year ahead and
// raises an error in the logs if fewer than MIN_MONTHS_AHEAD remain.

import { withTransaction } from './transaction.js';

export const PARTITIONED_TABLES = ['audit_logs'];
const MONTHS_AHEAD = 12;
const MIN_MONTHS_AHEAD = 3;

function partitionName(table, monthsFromNow) {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
  return `${table}_${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Serialized with an advisory lock, so two worker replicas never try to
// create the same partition at once.
export async function ensurePartitions(pool, logger) {
  return withTransaction(pool, (client) => maintain(client, logger));
}

async function maintain(db, logger) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('enviotec.partitions'))");
  const report = {};
  for (const table of PARTITIONED_TABLES) {
    const { rows } = await db.query('SELECT create_monthly_partitions($1::regclass, $2) AS created', [table, MONTHS_AHEAD]);
    const { rows: check } = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [partitionName(table, MIN_MONTHS_AHEAD)]);
    report[table] = { created: rows[0].created, ok: check[0].present };
    if (!check[0].present) {
      logger.error({ table, monthsAhead: MIN_MONTHS_AHEAD }, 'partition missing: inserts will fail when the month arrives');
    } else if (rows[0].created > 0) {
      logger.info({ table, created: rows[0].created }, 'partitions created');
    }
  }
  return report;
}
