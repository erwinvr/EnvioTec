import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig, parseTrustProxy } from '../../src/core/config/index.js';
import { validEnv } from '../helpers/app.js';

function problemsOf(env, options) {
  try {
    loadConfig(env, options);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems.join('\n');
  }
  assert.fail('se esperaba un ConfigError');
}

describe('loadConfig', () => {
  it('carga una configuración válida y aplica valores por defecto', () => {
    const config = loadConfig(validEnv());
    assert.equal(config.port, 3000);
    assert.equal(config.session.idleTimeoutMin, 30);
    assert.equal(config.session.absoluteTimeoutMin, 480);
    assert.equal(config.database.statementTimeoutMs, 10000);
    assert.equal(config.security.dataEncryptionKey.length, 32);
    assert.deepEqual(config.security.trustProxy, ['172.31.10.10']);
    assert.ok(Object.isFrozen(config.security));
  });

  it('usa nivel de log silent en tests salvo que se indique otro', () => {
    assert.equal(loadConfig(validEnv()).logLevel, 'silent');
    assert.equal(loadConfig(validEnv({ LOG_LEVEL: 'warn' })).logLevel, 'warn');
    assert.equal(loadConfig(validEnv({ NODE_ENV: 'production' })).logLevel, 'info');
  });

  it('rechaza la falta de variables obligatorias', () => {
    const env = validEnv();
    delete env.CSRF_SECRET;
    delete env.APP_ORIGIN;
    const problems = problemsOf(env);
    assert.match(problems, /CSRF_SECRET: es obligatoria/);
    assert.match(problems, /APP_ORIGIN: es obligatoria/);
  });

  it('rechaza valores fuera de rango', () => {
    assert.match(problemsOf(validEnv({ SESSION_IDLE_TIMEOUT_MIN: '1' })), /SESSION_IDLE_TIMEOUT_MIN/);
    assert.match(problemsOf(validEnv({ ARGON2_MEMORY_KIB: '1024' })), /ARGON2_MEMORY_KIB/);
    assert.match(problemsOf(validEnv({ NODE_ENV: 'staging' })), /NODE_ENV/);
  });

  it('rechaza secretos débiles o de ejemplo', () => {
    assert.match(problemsOf(validEnv({ CSRF_SECRET: 'change-me-change-me-change-me-change-me' })), /CSRF_SECRET: es débil/);
    assert.match(problemsOf(validEnv({ CSRF_SECRET: 'a'.repeat(64) })), /CSRF_SECRET: es débil/);
    assert.match(problemsOf(validEnv({ CSRF_SECRET: 'short' })), /CSRF_SECRET/);
  });

  it('rechaza claves de cifrado que no son 32 bytes aleatorios en base64', () => {
    assert.match(problemsOf(validEnv({ DATA_ENCRYPTION_KEY: randomBytes(16).toString('base64').repeat(2) })), /DATA_ENCRYPTION_KEY/);
    assert.match(problemsOf(validEnv({ DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') })), /DATA_ENCRYPTION_KEY/);
    assert.match(problemsOf(validEnv({ DATA_ENCRYPTION_KEY: '!'.repeat(44) })), /DATA_ENCRYPTION_KEY/);
  });

  it('no incluye los valores de los secretos en los mensajes de error', () => {
    const weakSecret = 'example-secret-value-that-is-long-enough';
    const problems = problemsOf(validEnv({ CSRF_SECRET: weakSecret, DATABASE_URL: 'mysql://user:topsecret@db' }));
    assert.ok(!problems.includes(weakSecret));
    assert.ok(!problems.includes('topsecret'));
  });

  it('exige APP_ORIGIN https sin ruta', () => {
    assert.match(problemsOf(validEnv({ APP_ORIGIN: 'http://enviotec.test' })), /APP_ORIGIN/);
    assert.match(problemsOf(validEnv({ APP_ORIGIN: 'https://enviotec.test/app' })), /APP_ORIGIN/);
  });

  it('lee secretos desde archivos (_FILE) y rechaza definirlos dos veces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'));
    const file = join(dir, 'csrf_secret');
    const secret = randomBytes(48).toString('base64');
    writeFileSync(file, `${secret}\n`);

    const env = validEnv();
    delete env.CSRF_SECRET;
    env.CSRF_SECRET_FILE = file;
    assert.equal(loadConfig(env).security.csrfSecret, secret);

    assert.match(problemsOf({ ...env, CSRF_SECRET: secret }), /definida a la vez/);
    assert.match(problemsOf({ ...env, CSRF_SECRET_FILE: join(dir, 'missing') }), /no se pudo leer/);
    assert.match(problemsOf(validEnv({ APP_ORIGIN_FILE: file })), /APP_ORIGIN_FILE: no se admite/);
  });

  it('el perfil worker no exige ni expone secretos de la API', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://app_runtime:pw@db/enviotec',
      REDIS_URL: 'redis://worker:pw@redis:6379/0',
      CSRF_SECRET: 'ignored',
    }, { profile: 'worker' });
    assert.equal(config.security, undefined);
    assert.equal(config.port, undefined);
    assert.deepEqual([config.sending.enabled, config.sending.apiUrl, config.sending.batchSize], [false, 'https://mandrillapp.com/api/1.0', 100]);
  });

  it('la API de Mandrill solo por https; http únicamente hacia loopback y fuera de producción', () => {
    const worker = (env) => loadConfig({
      NODE_ENV: 'development', DATABASE_URL: 'postgres://app_runtime:pw@db/enviotec', REDIS_URL: 'redis://worker:pw@redis:6379/0', ...env,
    }, { profile: 'worker' });
    assert.equal(worker({ MANDRILL_API_URL: 'http://127.0.0.1:9999/', MANDRILL_CAMPAIGNS_API_KEY: 'clave-de-campanias-de-prueba' }).sending.apiUrl, 'http://127.0.0.1:9999');
    assert.equal(worker({ MANDRILL_CAMPAIGNS_API_KEY: 'clave-de-campanias-de-prueba' }).sending.enabled, true);
    assert.throws(() => worker({ MANDRILL_API_URL: 'http://mandrill.evil.test' }), /MANDRILL_API_URL/);
    assert.throws(() => worker({ NODE_ENV: 'production', MANDRILL_API_URL: 'http://127.0.0.1:9999' }), /MANDRILL_API_URL/);
  });

  it('rechaza perfiles desconocidos', () => {
    assert.throws(() => loadConfig(validEnv(), { profile: 'other' }), /Perfil de configuración desconocido/);
  });
});

describe('parseTrustProxy', () => {
  it('acepta IPs y CIDR, y rechaza comodines', () => {
    assert.deepEqual(parseTrustProxy('172.31.10.10, 10.0.0.0/8'), ['172.31.10.10', '10.0.0.0/8']);
    assert.deepEqual(parseTrustProxy('fd00::/64'), ['fd00::/64']);
    assert.equal(parseTrustProxy('true'), null);
    assert.equal(parseTrustProxy('0.0.0.0/0'), null);
    assert.equal(parseTrustProxy('10.0.0.0/33'), null);
    assert.equal(parseTrustProxy(' , '), null);
  });
});
