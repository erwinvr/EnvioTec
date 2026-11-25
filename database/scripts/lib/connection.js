import { loadConfigOrExit } from '../../../backend/src/core/config/load-or-exit.js';
import { createPool } from '../../../backend/src/core/db/pool.js';
import { lockName, withTransaction } from '../../../backend/src/core/db/transaction.js';

// Tools connect with the owner login (MIGRATION_DATABASE_URL), never with the
// runtime one. The configuration is validated like any other process.
export function loadToolsConfig() {
  return loadConfigOrExit('tools');
}

const silentLogger = { error: (data, message) => console.error(message, data?.err?.message ?? '') };

export async function withOwnerDatabase(config, fn) {
  const db = await createPool(config.migrationDatabase, silentLogger, 'enviotec-tools');
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

// Runs fn(client) inside a transaction serialized by an application lock, so
// two tool runs cannot interleave.
export function inLockedTransaction(db, name, fn) {
  return withTransaction(db, async (client) => {
    await lockName(client, name, { timeoutMs: 60000 });
    return fn(client);
  });
}
