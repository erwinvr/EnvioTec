// Checks the edge proxy (nginx) of the running stack: TLS, redirect and
// security headers on every kind of response. Runs in scripts/check.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { before, describe, it } from 'node:test';

const baseUrl = process.env.EDGE_BASE_URL;
const httpUrl = process.env.EDGE_HTTP_URL;

const REQUIRED_HEADERS = {
  'strict-transport-security': /^max-age=63072000; includeSubDomains$/,
  'content-security-policy': /default-src 'self'.*frame-ancestors 'none'/,
  'x-content-type-options': /^nosniff$/,
  'referrer-policy': /^strict-origin-when-cross-origin$/,
  'permissions-policy': /camera=\(\)/,
  'cross-origin-opener-policy': /^same-origin$/,
};

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(target, { method: 'GET', timeout: 5000, ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

describe('proxy de borde (nginx)', { skip: !baseUrl && 'requiere EDGE_BASE_URL (scripts/check.sh)' }, () => {
  let ca;
  before(() => {
    ca = readFileSync(process.env.EDGE_CA_FILE);
  });

  for (const path of ['/', '/index.html', '/src/app.js', '/health/live', '/api/v1/no-existe', '/ruta/del/frontend']) {
    it(`incluye los headers de seguridad en ${path}`, async () => {
      const res = await get(`${baseUrl}${path}`, { ca });
      for (const [name, pattern] of Object.entries(REQUIRED_HEADERS)) {
        assert.match(res.headers[name] ?? '', pattern, `${path}: falta o es incorrecto ${name}`);
      }
      assert.ok(!/unsafe-inline|unsafe-eval/.test(res.headers['content-security-policy']));
      assert.equal(res.headers.server, 'nginx', 'no debe revelar la versión');
      assert.equal(res.headers['x-powered-by'], undefined);
    });
  }

  it('sirve el frontend y enruta /api y /health al backend', async () => {
    const page = await get(`${baseUrl}/`, { ca });
    assert.equal(page.status, 200);
    assert.match(page.body, /<script type="module" src="\/src\/app.js"><\/script>/);
    assert.ok(!/<script>|onclick=|style=/.test(page.body), 'sin scripts, handlers ni estilos inline');

    const health = await get(`${baseUrl}/health/ready`, { ca });
    assert.equal(health.status, 200);
    assert.equal(health.headers['cache-control'], 'no-store');

    const api = await get(`${baseUrl}/api/v1/no-existe`, { ca });
    assert.equal(api.status, 404);
    assert.equal(JSON.parse(api.body).error.code, 'NOT_FOUND');
  });

  it('un archivo inexistente bajo /src devuelve 404 y no la página principal', async () => {
    const res = await get(`${baseUrl}/src/no-existe.js`, { ca });
    assert.equal(res.status, 404);
  });

  it('HTTP redirige a HTTPS', async () => {
    const res = await get(`${httpUrl}/cualquier/ruta`);
    assert.equal(res.status, 301);
    assert.match(res.headers.location, /^https:\/\//);
  });

  it('rechaza TLS 1.1 o inferior', async () => {
    const { hostname, port } = new URL(baseUrl);
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: hostname, port: Number(port), ca, servername: hostname, maxVersion: 'TLSv1.1', minVersion: 'TLSv1' }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    }));
  });
});
