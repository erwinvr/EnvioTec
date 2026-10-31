// Environment variables accepted by each process. Values are validated with
// JSON Schema (ajv) and then with the semantic checks in index.js.

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export const PROPERTIES = {
  NODE_ENV: { type: 'string', enum: ['development', 'test', 'production'] },
  PORT: { type: 'integer', minimum: 1, maximum: 65535, default: 3000 },
  LOG_LEVEL: { type: 'string', enum: LOG_LEVELS },
  DATABASE_URL: { type: 'string', pattern: '^postgres(ql)?://.+' },
  MIGRATION_DATABASE_URL: { type: 'string', pattern: '^postgres(ql)?://.+' },
  DATABASE_POOL_MAX: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  DATABASE_STATEMENT_TIMEOUT_MS: { type: 'integer', minimum: 100, maximum: 600000, default: 10000 },
  REDIS_URL: { type: 'string', pattern: '^rediss?://.+' },
  SESSION_IDLE_TIMEOUT_MIN: { type: 'integer', minimum: 5, maximum: 120, default: 30 },
  SESSION_ABSOLUTE_TIMEOUT_MIN: { type: 'integer', minimum: 60, maximum: 1440, default: 480 },
  CSRF_SECRET: { type: 'string', minLength: 32 },
  DATA_ENCRYPTION_KEY: { type: 'string', minLength: 44 },
  TRUST_PROXY: { type: 'string', minLength: 1 },
  APP_ORIGIN: { type: 'string', pattern: '^https://[^/]+$' },
  ARGON2_MEMORY_KIB: { type: 'integer', minimum: 19456, maximum: 1048576, default: 19456 },
  ARGON2_ITERATIONS: { type: 'integer', minimum: 2, maximum: 10, default: 2 },
  ARGON2_PARALLELISM: { type: 'integer', minimum: 1, maximum: 16, default: 1 },
  RATE_LIMIT_LOGIN_PER_IP: { type: 'integer', minimum: 1, maximum: 1000, default: 20 },
  RATE_LIMIT_LOGIN_PER_ACCOUNT: { type: 'integer', minimum: 1, maximum: 100, default: 5 },
};

// Variables that may come from a Docker secret file (<NAME>_FILE).
export const SECRET_KEYS = new Set([
  'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'REDIS_URL', 'CSRF_SECRET', 'DATA_ENCRYPTION_KEY',
]);

// Each process receives only the variables it needs (least privilege).
export const PROFILES = {
  api: {
    required: ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'CSRF_SECRET', 'DATA_ENCRYPTION_KEY', 'TRUST_PROXY', 'APP_ORIGIN'],
    optional: [
      'PORT', 'LOG_LEVEL', 'DATABASE_POOL_MAX', 'DATABASE_STATEMENT_TIMEOUT_MS',
      'SESSION_IDLE_TIMEOUT_MIN', 'SESSION_ABSOLUTE_TIMEOUT_MIN',
      'ARGON2_MEMORY_KIB', 'ARGON2_ITERATIONS', 'ARGON2_PARALLELISM',
      'RATE_LIMIT_LOGIN_PER_IP', 'RATE_LIMIT_LOGIN_PER_ACCOUNT',
    ],
  },
  worker: {
    required: ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL'],
    optional: ['LOG_LEVEL', 'DATABASE_POOL_MAX', 'DATABASE_STATEMENT_TIMEOUT_MS'],
  },
  // Migrations, seeds and bootstrap (database/scripts), with the app_owner user.
  tools: {
    required: ['NODE_ENV', 'MIGRATION_DATABASE_URL'],
    optional: ['LOG_LEVEL', 'ARGON2_MEMORY_KIB', 'ARGON2_ITERATIONS', 'ARGON2_PARALLELISM'],
  },
};
