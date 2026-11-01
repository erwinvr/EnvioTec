import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildUrl, request, setCsrfToken } from '../src/core/api.js';
import { isSafeUrl } from '../src/core/dom.js';
import { describeError } from '../src/core/errors.js';
import { setLanguage } from '../src/core/i18n.js';
import { matchRoute, parseHash, resolve } from '../src/core/router.js';
import { validateField } from '../src/components/form.js';

setLanguage('es');

describe('router (solo experiencia de usuario; el backend decide)', () => {
  const routes = [
    { path: '/ingresar', public: true, guestOnly: true },
    { path: '/restablecer-contrasena', public: true },
    { path: '/mfa/verificar', stages: ['mfa_verify'] },
    { path: '/', },
    { path: '/usuarios/nuevo', permission: 'users.create_local' },
    { path: '/usuarios/:id', permission: 'users.view' },
  ];
  const session = (stage, permissions = []) => ({ signedIn: true, stage, permissions: new Set(permissions) });

  it('separa ruta y query del hash y extrae parámetros', () => {
    assert.deepEqual(parseHash('#/restablecer-contrasena?token=abc'), { path: '/restablecer-contrasena', query: { token: 'abc' } });
    assert.deepEqual(parseHash(''), { path: '/', query: {} });
    assert.deepEqual(matchRoute(routes, '/usuarios/123').params, { id: '123' });
    assert.equal(matchRoute(routes, '/usuarios/nuevo').route.path, '/usuarios/nuevo');
    assert.equal(matchRoute(routes, '/nada'), null);
  });

  it('sin sesión lleva al login recordando el destino; con sesión el login lleva al inicio', () => {
    assert.deepEqual(resolve(routes, '/usuarios/1', { signedIn: false }), { redirect: '/ingresar', returnTo: '/usuarios/1' });
    assert.deepEqual(resolve(routes, '/ingresar', session('full')), { redirect: '/' });
    assert.equal(resolve(routes, '/restablecer-contrasena', session('full')).route.path, '/restablecer-contrasena');
  });

  it('una etapa pendiente lleva a su pantalla; sin permiso muestra acceso denegado', () => {
    assert.deepEqual(resolve(routes, '/', session('mfa_verify')), { redirect: '/mfa/verificar' });
    assert.deepEqual(resolve(routes, '/mfa/verificar', session('full')), { redirect: '/' });
    assert.equal(resolve(routes, '/usuarios/1', session('full')).forbidden, true);
    assert.equal(resolve(routes, '/usuarios/1', session('full', ['users.view'])).forbidden, undefined);
    assert.equal(resolve(routes, '/no-existe', session('full')).notFound, true);
  });
});

describe('cliente API', () => {
  it('construye URLs relativas sin parámetros vacíos', () => {
    assert.equal(buildUrl('/api/v1/users', { page: 2, search: '', status: undefined, q: 'a b&c' }), '/api/v1/users?page=2&q=a+b%26c');
  });

  it('envía el token CSRF solo en métodos que modifican y traduce errores', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'x', details: [{ field: 'email', code: 'invalid_email' }], requestId: 'r1' } }),
        { status: 422, headers: { 'content-type': 'application/json' } });
    };
    setCsrfToken('token-csrf');
    await assert.rejects(request('POST', '/api/v1/users', { body: {}, fetchImpl }), (error) => error.status === 422 && error.details[0].field === 'email');
    await assert.rejects(request('GET', '/api/v1/users', { fetchImpl }));
    assert.equal(calls[0].options.headers['x-csrf-token'], 'token-csrf');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[1].options.headers['x-csrf-token'], undefined);
    setCsrfToken(null);
  });
});

describe('manejo de errores centralizado (A9)', () => {
  it('traduce cada caso sin detalles técnicos', () => {
    assert.equal(describeError({ status: 401, code: 'AUTHENTICATION_REQUIRED' }).kind, 'redirect');
    assert.equal(describeError({ status: 401, code: 'INVALID_CREDENTIALS' }).kind, 'message');
    assert.deepEqual(describeError({ status: 403, code: 'AUTH_STEP_REQUIRED', details: [{ field: 'stage', code: 'mfa_enroll' }] }),
      { kind: 'step', stage: 'mfa_enroll' });
    assert.equal(describeError({ status: 403, code: 'REAUTH_REQUIRED' }).kind, 'reauth');
    assert.match(describeError({ status: 403, code: 'FORBIDDEN' }).message, /permiso/);
    const fields = describeError({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'newPassword', code: 'common' }, { field: 'x', code: 'raro' }] });
    assert.equal(fields.kind, 'fields');
    assert.match(fields.fields.newPassword, /común/);
    assert.equal(fields.fields.x, 'Valor inválido');
    assert.match(describeError({ status: 429, retryAfter: 30 }).message, /30/);
    const server = describeError({ status: 500, code: 'INTERNAL_ERROR', requestId: 'abc-123', message: 'SELECT * FROM' });
    assert.match(server.message, /abc-123/);
    assert.doesNotMatch(server.message, /SELECT/);
    assert.equal(describeError({ status: 0, code: 'NETWORK_ERROR' }).message, 'No se pudo conectar con el servidor.');
  });
});

describe('validación de formularios (UX, replica el schema)', () => {
  it('obligatorio, longitudes, patrón, número y email', () => {
    assert.equal(validateField({ required: true }, ''), 'Obligatorio');
    assert.equal(validateField({ required: false }, ''), null);
    assert.match(validateField({ minLength: 12 }, 'corta'), /12/);
    assert.match(validateField({ maxLength: 3 }, 'larga'), /3/);
    assert.equal(validateField({ pattern: '[0-9]{6}' }, '12345a'), 'Formato inválido');
    assert.equal(validateField({ pattern: '[0-9]{6}' }, '123456'), null);
    assert.match(validateField({ type: 'number', max: 365 }, 400), /365/);
    assert.equal(validateField({ type: 'email' }, 'no-email'), 'Email inválido');
  });
});

describe('URLs seguras en atributos (A9)', () => {
  it('admite rutas propias, https, mailto y las imágenes y blobs que crea la app; rechaza javascript:', () => {
    for (const url of ['#/usuarios', '/src/app.js', 'https://empresa.test', 'mailto:a@b.test', 'blob:https://x/1', 'data:image/svg+xml;base64,AAA']) {
      assert.ok(isSafeUrl(url), url);
    }
    const scheme = ['java', 'script:'].join('');
    for (const url of [`${scheme}alert(1)`, ` ${scheme.toUpperCase()}alert(1)`, '//evil.test', 'data:text/html;base64,AAA', 'http://plano.test']) {
      assert.equal(isSafeUrl(url), false, url);
    }
  });
});
