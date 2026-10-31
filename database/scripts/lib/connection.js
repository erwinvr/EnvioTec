import pg from 'pg';
import { loadConfigOrExit } from '../../../backend/src/core/config/load-or-exit.js';

// Tools connect with the app_owner user (MIGRATION_DATABASE_URL), never with
// the runtime user. The configuration is validated like any other process.
export function loadToolsConfig() {
  return loadConfigOrExit('tools');
}

export async function withOwnerClient(config, fn) {
  const client = new pg.Client({ connectionString: config.migrationDatabaseUrl, application_name: 'enviotec-tools' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Runs fn inside a transaction serialized by an advisory lock, so two tool
// runs cannot interleave.
export async function inLockedTransaction(client, lockName, fn) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockName]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
