import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { stripSensitive } from '../../src/core/audit/audit.service.js';
import { clearedSessionCookie, sessionCookie } from '../../src/core/auth/session-token.js';
import { computeStage, createMfaPolicy } from '../../src/core/auth/stage.js';
import { base32Encode, hotp, otpauthUri, timeStep, verifyTotp } from '../../src/core/auth/totp.js';
import { assertRecentReauth } from '../../src/core/authorization/authorization.js';
import { deriveCsrfToken, isValidCsrfToken } from '../../src/core/security/csrf.js';
import { decryptSecret, encryptSecret } from '../../src/core/security/encryption.js';
import { createRateLimiter } from '../../src/core/security/rate-limiter.js';
import { lockMinutesFor } from '../../src/modules/auth/credentials.service.js';
import { generateCode, hashCode } from '../../src/modules/auth/mfa.service.js';
import { PERMISSION_CATALOG } from '../../src/modules/permission-catalog.js';
import { memoryRedis } from '../helpers/app.js';

const RFC_SECRET = Buffer.from('12345678901234567890');

describe('TOTP (RFC 4226 y RFC 6238)', () => {
  it('HOTP coincide con los vectores del RFC 4226', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter), code));
  });

  it('TOTP SHA-1 coincide con los vectores del RFC 6238 (8 dígitos)', () => {
    const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'],
      [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [seconds, code] of vectors) assert.equal(hotp(RFC_SECRET, timeStep(seconds * 1000), 8), code);
  });

  it('acepta el paso actual y uno de tolerancia, y rechaza el resto', () => {
    const now = 1_800_000_000_000;
    const step = timeStep(now);
    assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), { nowMs: now }), step);
    assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), { nowMs: now }), step - 1);
    assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), { nowMs: now }), step + 1);
    assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), { nowMs: now }), null);
    for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456]) assert.equal(verifyTotp(RFC_SECRET, bad, { nowMs: now }), null);
  });

  it('base32 y otpauth siguen el formato de las apps autenticadoras', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    const uri = new URL(otpauthUri(RFC_SECRET, { issuer: 'EnvioTec', account: 'ana.perez' }));
    assert.equal(uri.protocol, 'otpauth:');
    assert.equal(uri.searchParams.get('secret'), base32Encode(RFC_SECRET));
    assert.equal(uri.searchParams.get('issuer'), 'EnvioTec');
  });
});

describe('cifrado de secretos (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('descifra con la misma clave y el mismo dueño', () => {
    const payload = encryptSecret(key, Buffer.from('secreto'), 'mfa:u1');
    assert.equal(decryptSecret(key, payload, 'mfa:u1').toString(), 'secreto');
  });

  it('falla si cambia el dueño, la clave o un byte del texto cifrado', () => {
    const payload = encryptSecret(key, Buffer.from('secreto'), 'mfa:u1');
    assert.throws(() => decryptSecret(key, payload, 'mfa:u2'));
    assert.throws(() => decryptSecret(randomBytes(32), payload, 'mfa:u1'));
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptSecret(key, tampered, 'mfa:u1'));
    assert.throws(() => decryptSecret(key, Buffer.from([9, 1, 2]), 'mfa:u1'));
  });
});

describe('token CSRF y cookie de sesión', () => {
  const secret = randomBytes(32).toString('hex');
  const session = randomBytes(32);

  it('el token está ligado a la sesión', () => {
    const token = deriveCsrfToken(secret, session);
    assert.ok(isValidCsrfToken(secret, session, token));
    assert.ok(!isValidCsrfToken(secret, randomBytes(32), token));
    assert.ok(!isValidCsrfToken('otro-secreto', session, token));
    for (const bad of [undefined, '', 'x', token.slice(1), 'a'.repeat(200)]) assert.ok(!isValidCsrfToken(secret, session, bad));
  });

  it('la cookie usa __Host-, Secure, HttpOnly y SameSite=Strict, sin Domain', () => {
    const cookie = sessionCookie('abc', 60);
    assert.match(cookie, /^__Host-enviotec_session=abc; Path=\/; Max-Age=60; Secure; HttpOnly; SameSite=Strict$/);
    assert.ok(!/domain/i.test(cookie));
    assert.match(clearedSessionCookie(), /Max-Age=0/);
  });
});

describe('etapas de la sesión y política de MFA', () => {
  it('ordena las etapas: MFA pendiente, cambio de contraseña, enrolamiento, completa', () => {
    const base = { mfaEnabled: false, mfaVerified: false, mustChangePassword: false, mfaRequired: false };
    assert.equal(computeStage(base), 'full');
    assert.equal(computeStage({ ...base, mfaEnabled: true }), 'mfa_verify');
    assert.equal(computeStage({ ...base, mfaEnabled: true, mfaVerified: true, mustChangePassword: true }), 'password_change');
    assert.equal(computeStage({ ...base, mustChangePassword: true, mfaRequired: true }), 'password_change');
    assert.equal(computeStage({ ...base, mfaRequired: true }), 'mfa_enroll');
    assert.equal(computeStage({ ...base, mfaRequired: true, mfaEnabled: true, mfaVerified: true }), 'full');
  });

  it('el MFA es obligatorio con permisos administrativos y para enviar o aprobar campañas', () => {
    const policy = createMfaPolicy(PERMISSION_CATALOG);
    assert.ok(policy.isRequired(new Set(['users.unlock'])));
    assert.ok(policy.isRequired(new Set(['campaigns.submit'])));
    assert.ok(policy.isRequired(new Set(['campaigns.approve'])));
    assert.ok(!policy.isRequired(new Set(['campaigns.view', 'reports.view'])));
    assert.ok(!policy.isRequired(new Set()));
  });

  it('la re-autenticación vale 5 minutos', () => {
    const now = Date.now();
    assert.doesNotThrow(() => assertRecentReauth({ session: { reauthAt: new Date(now - 4 * 60000) } }, now));
    for (const reauthAt of [null, new Date(now - 6 * 60000)]) {
      assert.throws(() => assertRecentReauth({ session: { reauthAt } }, now), (error) => error.code === 'REAUTH_REQUIRED');
    }
  });
});

describe('bloqueo de cuentas', () => {
  const lockout = { localThreshold: 5, localMaxMinutes: 60, adThreshold: 2, adMinutes: 15 };

  it('cuentas locales: bloqueo progresivo desde el umbral, con máximo', () => {
    assert.deepEqual([1, 4, 5, 6, 7, 10, 30].map((n) => lockMinutesFor('local', n, lockout)), [0, 0, 1, 2, 4, 32, 60]);
  });

  it('cuentas de AD: 15 minutos a los 2 intentos, antes del límite de 3 de AD', () => {
    assert.deepEqual([1, 2, 3].map((n) => lockMinutesFor('ad', n, lockout)), [0, 15, 15]);
  });
});

describe('rate limiter', () => {
  it('cuenta por ventana y devuelve el tiempo de espera', async () => {
    const limiter = createRateLimiter(memoryRedis());
    for (let i = 1; i <= 3; i += 1) assert.ok((await limiter.hit('k', { limit: 3, windowSeconds: 60 })).allowed);
    const blocked = await limiter.hit('k', { limit: 3, windowSeconds: 60 });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
    await limiter.reset('k');
    assert.ok((await limiter.hit('k', { limit: 3, windowSeconds: 60 })).allowed);
  });

  it('el candado por clave admite un solo dueño a la vez', async () => {
    const limiter = createRateLimiter(memoryRedis());
    const release = await limiter.acquire('lock', 1000);
    assert.ok(release);
    assert.equal(await limiter.acquire('lock', 1000), null);
    await release();
    assert.ok(await limiter.acquire('lock', 1000));
  });
});

describe('códigos de MFA y metadatos de auditoría', () => {
  it('los códigos son aleatorios, legibles y se comparan normalizados', () => {
    const code = generateCode(16, 4);
    assert.equal(code.length, 19);
    assert.ok(code.split('-').every((group) => /^[A-Z2-7]{4}$/.test(group)));
    assert.notEqual(code, generateCode(16, 4));
    assert.deepEqual(hashCode(code.toLowerCase().replaceAll('-', ' ')), hashCode(code));
    assert.match(generateCode(10, 5), /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  it('la auditoría nunca guarda campos sensibles en metadata', () => {
    assert.deepEqual(stripSensitive({ reason: 'x', password: 'p', newPassword: 'p', token: 't', enrollmentCode: 'c', failures: 2 }),
      { reason: 'x', failures: 2 });
  });
});
