import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { Ajv } from 'ajv';
import { LDAP_KEYS, PROFILES, PROPERTIES, SECRET_KEYS } from './schema.js';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Configuración inválida:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const PLACEHOLDER_PATTERN = /change[-_ ]?me|example|placeholder|xxxx/i;
const MIN_DISTINCT_CHARS = 16;

const ajv = new Ajv({ coerceTypes: true, useDefaults: true, allErrors: true, removeAdditional: false });

// Loads and validates the configuration for a process profile. Never includes
// variable values in error messages, because they may be secrets.
export function loadConfig(env, { profile = 'api', readFile = readFileSync } = {}) {
  const definition = PROFILES[profile];
  if (!definition) throw new Error(`Perfil de configuración desconocido: ${profile}`);

  const keys = [...definition.required, ...definition.optional];
  const problems = [];
  const raw = readRawValues(env, keys, readFile, problems);
  if (raw.NODE_ENV === 'test' && raw.LOG_LEVEL === undefined) raw.LOG_LEVEL = 'silent';
  if (raw.LOG_LEVEL === undefined) raw.LOG_LEVEL = 'info';

  const schema = {
    type: 'object',
    properties: Object.fromEntries(keys.map((key) => [key, PROPERTIES[key]])),
    required: definition.required,
    additionalProperties: false,
  };
  const validate = ajv.compile(schema);
  if (!validate(raw)) {
    for (const error of validate.errors) problems.push(describeSchemaError(error));
  }
  if (problems.length === 0) checkSemantics(raw, problems);
  if (problems.length > 0) throw new ConfigError(problems);

  return buildConfig(raw);
}

function readRawValues(env, keys, readFile, problems) {
  const raw = {};
  for (const key of keys) {
    const fileKey = `${key}_FILE`;
    const direct = nonEmpty(env[key]);
    const filePath = nonEmpty(env[fileKey]);
    if (filePath !== undefined && !SECRET_KEYS.has(key)) {
      problems.push(`${fileKey}: no se admite; ${key} no es un secreto`);
      continue;
    }
    if (direct !== undefined && filePath !== undefined) {
      problems.push(`${key}: definida a la vez como variable y como archivo (${fileKey})`);
      continue;
    }
    if (filePath !== undefined) {
      try {
        // The path comes from the deployment configuration, not from users.
        raw[key] = nonEmpty(readFile(filePath, 'utf8').replace(/\r?\n$/, ''));
      } catch {
        problems.push(`${fileKey}: no se pudo leer el archivo`);
      }
    } else if (direct !== undefined) {
      raw[key] = direct;
    }
  }
  return raw;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function describeSchemaError(error) {
  if (error.keyword === 'required') return `${error.params.missingProperty}: es obligatoria`;
  const key = error.instancePath.replace(/^\//, '');
  return `${key}: valor inválido (${error.keyword})`;
}

function checkSemantics(raw, problems) {
  if (raw.CSRF_SECRET !== undefined && isWeakSecret(raw.CSRF_SECRET)) {
    problems.push('CSRF_SECRET: es débil o es un valor de ejemplo; genere uno aleatorio de al menos 32 caracteres');
  }
  if (raw.DATA_ENCRYPTION_KEY !== undefined && !isValidEncryptionKey(raw.DATA_ENCRYPTION_KEY)) {
    problems.push('DATA_ENCRYPTION_KEY: debe ser una clave aleatoria de 32 bytes en base64');
  }
  if (raw.TRUST_PROXY !== undefined && parseTrustProxy(raw.TRUST_PROXY) === null) {
    problems.push('TRUST_PROXY: debe ser una lista de IPs o CIDR separadas por coma');
  }
  if (raw.APP_ORIGIN !== undefined && !isOrigin(raw.APP_ORIGIN)) {
    problems.push('APP_ORIGIN: debe ser un origen https sin ruta, por ejemplo https://enviotec.empresa.local');
  }
  if (raw.AD_ENABLED === true) {
    for (const key of LDAP_KEYS) {
      if (raw[key] === undefined) problems.push(`${key}: es obligatoria cuando AD_ENABLED=true`);
    }
  }
  if (raw.MANDRILL_SYSTEM_API_KEY !== undefined && raw.MAIL_FROM === undefined) {
    problems.push('MAIL_FROM: es obligatoria cuando se define MANDRILL_SYSTEM_API_KEY');
  }
}

function isWeakSecret(value) {
  return PLACEHOLDER_PATTERN.test(value) || new Set(value).size < MIN_DISTINCT_CHARS;
}

function isValidEncryptionKey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 && new Set(key).size > 1;
}

export function parseTrustProxy(value) {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split('/');
    const version = isIP(address);
    if (version === 0 || rest.length > 0) return null;
    if (prefix !== undefined) {
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || bits < 8 || bits > (version === 4 ? 32 : 128)) return null;
    }
  }
  return entries;
}

function isOrigin(value) {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

// Builds the configuration object with only the sections whose variables
// belong to the profile.
function buildConfig(raw) {
  const config = { env: raw.NODE_ENV, logLevel: raw.LOG_LEVEL };
  if (raw.DATABASE_URL !== undefined) {
    config.database = {
      url: raw.DATABASE_URL,
      poolMax: raw.DATABASE_POOL_MAX,
      statementTimeoutMs: raw.DATABASE_STATEMENT_TIMEOUT_MS,
    };
  }
  if (raw.MIGRATION_DATABASE_URL !== undefined) config.migrationDatabaseUrl = raw.MIGRATION_DATABASE_URL;
  if (raw.REDIS_URL !== undefined) config.redis = { url: raw.REDIS_URL };
  if (raw.PORT !== undefined) config.port = raw.PORT;
  if (raw.APP_ORIGIN !== undefined) {
    config.security = {
      appOrigin: raw.APP_ORIGIN,
      trustProxy: parseTrustProxy(raw.TRUST_PROXY),
      csrfSecret: raw.CSRF_SECRET,
      dataEncryptionKey: Buffer.from(raw.DATA_ENCRYPTION_KEY, 'base64'),
    };
    config.session = {
      idleTimeoutMin: raw.SESSION_IDLE_TIMEOUT_MIN,
      absoluteTimeoutMin: raw.SESSION_ABSOLUTE_TIMEOUT_MIN,
    };
    config.rateLimit = {
      loginPerIp: raw.RATE_LIMIT_LOGIN_PER_IP,
      loginPerAccount: raw.RATE_LIMIT_LOGIN_PER_ACCOUNT,
    };
    config.lockout = {
      localThreshold: raw.LOCKOUT_LOCAL_THRESHOLD,
      localMaxMinutes: raw.LOCKOUT_LOCAL_MAX_MIN,
      adThreshold: raw.LOCKOUT_AD_THRESHOLD,
      adMinutes: raw.LOCKOUT_AD_MIN,
    };
    config.passwordReset = { ttlMinutes: raw.PASSWORD_RESET_TTL_MIN };
  }
  if ('AD_ENABLED' in raw) {
    config.ad = raw.AD_ENABLED
      ? {
        enabled: true,
        url: raw.LDAP_URL,
        caCert: raw.LDAP_CA_CERT,
        bindDn: raw.LDAP_BIND_DN,
        bindPassword: raw.LDAP_BIND_PASSWORD,
        baseDn: raw.LDAP_BASE_DN,
        allowedGroupDn: raw.LDAP_ALLOWED_GROUP_DN,
        timeoutMs: raw.LDAP_TIMEOUT_MS,
      }
      : { enabled: false };
    config.mail = raw.MANDRILL_SYSTEM_API_KEY !== undefined
      ? { enabled: true, apiKey: raw.MANDRILL_SYSTEM_API_KEY, from: raw.MAIL_FROM, fromName: raw.MAIL_FROM_NAME }
      : { enabled: false };
  }
  if (raw.ARGON2_MEMORY_KIB !== undefined) {
    config.argon2 = {
      memoryKib: raw.ARGON2_MEMORY_KIB,
      iterations: raw.ARGON2_ITERATIONS,
      parallelism: raw.ARGON2_PARALLELISM,
    };
  }
  return deepFreeze(config);
}

function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) deepFreeze(value);
  }
  return Object.freeze(object);
}
