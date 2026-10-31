// Checks outbound traffic control (ADR-009): the internal networks have no
// route to the internet and the egress proxy only tunnels to the allowlist.
// Runs in scripts/check.sh, on the same networks as the backend.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { describe, it } from 'node:test';

const proxy = process.env.EGRESS_PROXY;

function tunnel(destination) {
  const [host, port] = proxy.split(':');
  return new Promise((resolve, reject) => {
    const req = request({ host, port: Number(port), method: 'CONNECT', path: destination, timeout: 10000 });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

describe('control de egreso', { skip: !proxy && 'requiere EGRESS_PROXY (scripts/check.sh)' }, () => {
  it('permite el túnel HTTPS hacia la API de Mandrill', async () => {
    assert.equal(await tunnel('mandrillapp.com:443'), 200);
  });

  it('rechaza destinos fuera de la allowlist', async () => {
    assert.equal(await tunnel('example.com:443'), 403);
    assert.equal(await tunnel('1.1.1.1:443'), 403);
  });

  it('rechaza puertos distintos de 443 aunque el dominio esté permitido', async () => {
    assert.equal(await tunnel('mandrillapp.com:80'), 403);
  });

  it('rechaza peticiones HTTP sin túnel', async () => {
    const [host, port] = proxy.split(':');
    const status = await new Promise((resolve, reject) => {
      const req = request({ host, port: Number(port), method: 'GET', path: 'http://mandrillapp.com/', timeout: 10000 }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it('sin el proxy no hay salida directa a internet', async () => {
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = connect({ host: '1.1.1.1', port: 443, timeout: 3000 }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('timeout', () => socket.destroy(new Error('timeout')));
      socket.on('error', reject);
    }));
  });
});
