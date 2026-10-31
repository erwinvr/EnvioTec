import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_ARGON2_PARAMS, hashPassword, MAX_PASSWORD_BYTES, verifyPassword } from '../../src/core/auth/password.js';
import { checkPassword } from '../../src/core/auth/password-policy.js';

describe('hash de contraseñas (Argon2id)', () => {
  it('genera hashes PHC argon2id con sal aleatoria', async () => {
    const first = await hashPassword('una frase larga y segura');
    const second = await hashPassword('una frase larga y segura');
    assert.match(first, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    assert.notEqual(first, second);
  });

  it('verifica la contraseña correcta y rechaza la incorrecta', async () => {
    const hash = await hashPassword('una frase larga y segura');
    assert.deepEqual(await verifyPassword(hash, 'una frase larga y segura'), { valid: true, needsRehash: false });
    assert.deepEqual(await verifyPassword(hash, 'una frase larga y segurA'), { valid: false, needsRehash: false });
  });

  it('pide rehash si cambian los parámetros (A5)', async () => {
    const hash = await hashPassword('una frase larga y segura');
    const stronger = { ...DEFAULT_ARGON2_PARAMS, iterations: 3 };
    assert.deepEqual(await verifyPassword(hash, 'una frase larga y segura', stronger), { valid: true, needsRehash: true });
  });

  it('rechaza hashes con formato inválido o de otros algoritmos', async () => {
    for (const stored of [null, '', 'plaintext', '$2b$10$abcdefghijklmnopqrstuv', '$argon2i$v=19$m=19456,t=2,p=1$abc$def']) {
      assert.deepEqual(await verifyPassword(stored, 'x'), { valid: false, needsRehash: false });
    }
  });

  it('limita el tamaño de la entrada', async () => {
    await assert.rejects(hashPassword('x'.repeat(MAX_PASSWORD_BYTES + 1)), TypeError);
    await assert.rejects(hashPassword(12345), TypeError);
  });
});

describe('política de contraseñas', () => {
  it('acepta frases largas sin reglas de composición', () => {
    assert.deepEqual(checkPassword('correct horse battery staple'), []);
    assert.deepEqual(checkPassword('mi gato duerme en la ventana'), []);
  });

  it('exige entre 12 y 128 caracteres', () => {
    assert.deepEqual(checkPassword('corta1234'), ['too_short']);
    assert.deepEqual(checkPassword('x'.repeat(129)), ['too_long']);
    assert.deepEqual(checkPassword(undefined), ['invalid']);
  });

  it('rechaza contraseñas comunes y sus variaciones triviales', () => {
    assert.ok(checkPassword('Password2026!').includes('common'));
    assert.ok(checkPassword('!!qwerty123456').includes('common'));
    assert.ok(checkPassword('Superman1234567').includes('common'));
  });

  it('rechaza contraseñas repetitivas', () => {
    assert.ok(checkPassword('aaaaaaaaaaaaaaaa').includes('repetitive'));
    assert.ok(checkPassword('abababababababab').includes('repetitive'));
  });

  it('rechaza contraseñas con datos de la cuenta o el nombre de la aplicación', () => {
    assert.ok(checkPassword('soy-jperez-y-esta-es-mi-clave', { username: 'jperez' }).includes('contains_account_data'));
    assert.ok(checkPassword('juan.perez es mi clave segura', { email: 'juan.perez@empresa.com' }).includes('contains_account_data'));
    assert.ok(checkPassword('Clave de EnvioTec muy segura').includes('contains_account_data'));
  });
});
