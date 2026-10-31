import { pino } from 'pino';

const CENSOR = '[REDACTED]';

// Field names that must never reach the logs, at any of the first three
// levels of nesting (pino's redaction does not support recursive wildcards).
const SENSITIVE_FIELDS = [
  'password', 'currentPassword', 'newPassword', 'password_hash', 'passwordHash',
  'token', 'accessToken', 'refreshToken', 'csrfToken', 'resetToken',
  'secret', 'mfaSecret', 'mfa_secret', 'mfaCode', 'totp', 'recoveryCode', 'recoveryCodes',
  'apiKey', 'api_key', 'authorization', 'cookie',
];

export const REDACT_PATHS = [
  ...SENSITIVE_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

export function createLogger(config, { service, destination } = {}) {
  const options = {
    level: config.logLevel,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  if (config.env === 'development' && !destination) {
    options.transport = { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } };
  }
  return destination ? pino(options, destination) : pino(options);
}
