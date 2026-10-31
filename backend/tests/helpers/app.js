import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/core/config/index.js';

export const PROXY_IP = '172.31.10.10';

export function validEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app_runtime:pw@localhost:5432/enviotec',
    REDIS_URL: 'redis://backend:pw@localhost:6379/0',
    CSRF_SECRET: randomBytes(48).toString('base64'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    TRUST_PROXY: PROXY_IP,
    APP_ORIGIN: 'https://enviotec.test',
    ...overrides,
  };
}

// Captures log lines in memory so tests can inspect what would be logged.
export function memoryLogger() {
  const lines = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, destination), lines };
}

export const healthyChecks = { database: async () => {}, redis: async () => {} };

export async function buildTestApp({ checks = healthyChecks, extraPlugins = [], logger } = {}) {
  const config = loadConfig(validEnv());
  return buildApp({ config, logger: logger ?? pino({ level: 'silent' }), checks, extraPlugins });
}
