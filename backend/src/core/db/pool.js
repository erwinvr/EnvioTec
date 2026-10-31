import pg from 'pg';

const CONNECTION_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30000;

export function createPool(databaseConfig, logger, applicationName) {
  const pool = new pg.Pool({
    connectionString: databaseConfig.url,
    max: databaseConfig.poolMax,
    statement_timeout: databaseConfig.statementTimeoutMs,
    query_timeout: databaseConfig.statementTimeoutMs + 1000,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    application_name: applicationName,
  });
  pool.on('error', (error) => logger.error({ err: error }, 'postgres idle client error'));
  return pool;
}
