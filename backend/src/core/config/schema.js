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
  // Progressive lockout of local accounts: from the threshold on, each failure
  // doubles the lock (1, 2, 4... minutes) up to the maximum.
  LOCKOUT_LOCAL_THRESHOLD: { type: 'integer', minimum: 3, maximum: 20, default: 5 },
  LOCKOUT_LOCAL_MAX_MIN: { type: 'integer', minimum: 1, maximum: 1440, default: 60 },
  // AD locks at 3 failures and resets its counter after 15 minutes: EnvioTec
  // stops before that (ADR-006).
  LOCKOUT_AD_THRESHOLD: { type: 'integer', minimum: 1, maximum: 2, default: 2 },
  LOCKOUT_AD_MIN: { type: 'integer', minimum: 15, maximum: 1440, default: 15 },
  PASSWORD_RESET_TTL_MIN: { type: 'integer', minimum: 15, maximum: 30, default: 30 },
  AD_ENABLED: { type: 'boolean', default: false },
  LDAP_URL: { type: 'string', pattern: '^ldaps://[^/]+$' },
  LDAP_CA_CERT: { type: 'string', pattern: '-----BEGIN CERTIFICATE-----' },
  LDAP_BIND_DN: { type: 'string', minLength: 3, maxLength: 500 },
  LDAP_BIND_PASSWORD: { type: 'string', minLength: 1 },
  LDAP_BASE_DN: { type: 'string', minLength: 3, maxLength: 500 },
  LDAP_ALLOWED_GROUP_DN: { type: 'string', minLength: 3, maxLength: 500 },
  LDAP_TIMEOUT_MS: { type: 'integer', minimum: 1000, maximum: 30000, default: 5000 },
  MANDRILL_SYSTEM_API_KEY: { type: 'string', minLength: 10, maxLength: 200 },
  MAIL_FROM: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', maxLength: 254 },
  MAIL_FROM_NAME: { type: 'string', minLength: 1, maxLength: 100, default: 'EnvioTec' },
  // Campaign sending (ADR-005): its own API key, separate from system mail.
  MANDRILL_CAMPAIGNS_API_KEY: { type: 'string', minLength: 10, maxLength: 200 },
  MANDRILL_API_URL: { type: 'string', default: 'https://mandrillapp.com/api/1.0' },
  SENDING_BATCH_SIZE: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
  FILES_DIR: { type: 'string', pattern: '^/[A-Za-z0-9/_.-]+$', default: '/data/files' },
  CLAMAV_HOST: { type: 'string', pattern: '^[A-Za-z0-9.-]+$', default: 'clamav' },
  CLAMAV_PORT: { type: 'integer', minimum: 1, maximum: 65535, default: 3310 },
};

// Variables required when AD_ENABLED is true.
export const LDAP_KEYS = ['LDAP_URL', 'LDAP_CA_CERT', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_BASE_DN',
  'LDAP_ALLOWED_GROUP_DN'];

// Variables that may come from a Docker secret file (<NAME>_FILE).
export const SECRET_KEYS = new Set([
  'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'REDIS_URL', 'CSRF_SECRET', 'DATA_ENCRYPTION_KEY',
  'LDAP_BIND_PASSWORD', 'LDAP_CA_CERT', 'MANDRILL_SYSTEM_API_KEY', 'MANDRILL_CAMPAIGNS_API_KEY',
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
      'LOCKOUT_LOCAL_THRESHOLD', 'LOCKOUT_LOCAL_MAX_MIN', 'LOCKOUT_AD_THRESHOLD', 'LOCKOUT_AD_MIN',
      'PASSWORD_RESET_TTL_MIN', 'AD_ENABLED', 'LDAP_URL', 'LDAP_CA_CERT', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD',
      'LDAP_BASE_DN', 'LDAP_ALLOWED_GROUP_DN', 'LDAP_TIMEOUT_MS', 'MANDRILL_SYSTEM_API_KEY', 'MAIL_FROM',
      'MAIL_FROM_NAME', 'FILES_DIR',
    ],
  },
  // The worker reviews AD accounts and sends account notices (phase 5).
  worker: {
    required: ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL'],
    optional: [
      'LOG_LEVEL', 'DATABASE_POOL_MAX', 'DATABASE_STATEMENT_TIMEOUT_MS',
      'AD_ENABLED', 'LDAP_URL', 'LDAP_CA_CERT', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_BASE_DN',
      'LDAP_ALLOWED_GROUP_DN', 'LDAP_TIMEOUT_MS', 'MANDRILL_SYSTEM_API_KEY', 'MAIL_FROM', 'MAIL_FROM_NAME', 'FILES_DIR',
      'MANDRILL_CAMPAIGNS_API_KEY', 'MANDRILL_API_URL', 'SENDING_BATCH_SIZE',
    ],
  },
  // Untrusted file inspection (ADR-004): no database, only Redis and ClamAV.
  'file-processor': {
    required: ['NODE_ENV', 'REDIS_URL'],
    optional: ['LOG_LEVEL', 'FILES_DIR', 'CLAMAV_HOST', 'CLAMAV_PORT'],
  },
  // Migrations, seeds and bootstrap (database/scripts), with the app_owner user.
  tools: {
    required: ['NODE_ENV', 'MIGRATION_DATABASE_URL'],
    optional: ['LOG_LEVEL', 'ARGON2_MEMORY_KIB', 'ARGON2_ITERATIONS', 'ARGON2_PARALLELISM'],
  },
};
