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

// Database double for unit tests: every query returns no rows, so no session
// is ever valid. Tests with a real database live in tests/integration.
export const emptyDb = { query: async () => ({ rows: [], rowCount: 0 }) };

// In-memory stand-in for the few Redis commands the rate limiter uses.
export function memoryRedis() {
  const values = new Map();
  const expiries = new Map();
  const alive = (key) => {
    if (expiries.has(key) && expiries.get(key) <= Date.now()) {
      values.delete(key);
      expiries.delete(key);
    }
    return values.has(key);
  };
  return {
    async incr(key) {
      const next = (alive(key) ? Number(values.get(key)) : 0) + 1;
      values.set(key, String(next));
      return next;
    },
    async expire(key, seconds, mode) {
      if (!alive(key) || (mode === 'NX' && expiries.has(key))) return 0;
      expiries.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    async pttl(key) {
      if (!alive(key)) return -2;
      return expiries.has(key) ? expiries.get(key) - Date.now() : -1;
    },
    async get(key) {
      return alive(key) ? values.get(key) : null;
    },
    async set(key, value, unit, amount, mode) {
      if (mode === 'NX' && alive(key)) return null;
      values.set(key, value);
      expiries.set(key, Date.now() + (unit === 'PX' ? amount : amount * 1000));
      return 'OK';
    },
    async del(key) {
      const existed = alive(key);
      values.delete(key);
      expiries.delete(key);
      return existed ? 1 : 0;
    },
  };
}

export const ORIGIN = 'https://enviotec.test';

export async function buildTestApp({
  checks = healthyChecks, extraPlugins = [], logger, db = emptyDb, redis = memoryRedis(), mailer,
} = {}) {
  const config = loadConfig(validEnv());
  return buildApp({ config, logger: logger ?? pino({ level: 'silent' }), db, redis, checks, mailer, extraPlugins });
}
