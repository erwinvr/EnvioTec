import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { createLogger } from '../../src/core/logging/logger.js';

function capture() {
  const lines = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('redacta campos sensibles en los primeros niveles', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ logLevel: 'info', env: 'production' }, { service: 'test', destination });

    logger.info({
      password: 'p-1',
      user: { token: 't-2', mfaSecret: 'm-3' },
      body: { nested: { newPassword: 'p-4' } },
      req: { headers: { authorization: 'Bearer a-5', cookie: 'sid=c-6', 'x-csrf-token': 'x-7' } },
      res: { headers: { 'set-cookie': 's-8' } },
      apiKey: 'k-9',
    }, 'evento');

    const output = lines.join('');
    for (const secret of ['p-1', 't-2', 'm-3', 'p-4', 'a-5', 'c-6', 'x-7', 's-8', 'k-9']) {
      assert.ok(!output.includes(secret), `el log contiene ${secret}`);
    }
    assert.match(output, /\[REDACTED\]/);
  });

  it('escribe JSON con nivel textual, servicio y hora ISO', () => {
    const { lines, destination } = capture();
    createLogger({ logLevel: 'info', env: 'production' }, { service: 'backend', destination }).info('hola');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.level, 'info');
    assert.equal(entry.service, 'backend');
    assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('respeta el nivel configurado', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ logLevel: 'silent', env: 'test' }, { service: 'test', destination });
    logger.error('no debe aparecer');
    assert.equal(lines.length, 0);
  });
});
