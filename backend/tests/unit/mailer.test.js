import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMailer } from '../../src/core/mail/mailer.js';
import { memoryLogger } from '../helpers/app.js';

const CONFIG = { enabled: true, apiKey: 'clave-de-sistema-de-prueba', from: 'no-reply@envios.test', fromName: 'EnvioTec' };

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    return { ok: status < 400, status, json: async () => body };
  };
  return { impl, calls };
}

describe('correo del sistema (Mandrill)', () => {
  it('envía con la API key de sistema, sin seguimiento de aperturas ni de clics', async () => {
    const { impl, calls } = fakeFetch(200, [{ status: 'sent' }]);
    const mailer = createMailer(CONFIG, memoryLogger().logger, { fetchImpl: impl });
    await mailer.send({ to: 'ana@empresa.test', subject: 'Asunto', text: 'Hola', tag: 'password-reset' });
    assert.equal(calls[0].url, 'https://mandrillapp.com/api/1.0/messages/send');
    const { key, message } = calls[0].payload;
    assert.equal(key, CONFIG.apiKey);
    assert.deepEqual(message.to, [{ email: 'ana@empresa.test', type: 'to' }]);
    // Click tracking would rewrite the reset link through Mandrill's domain.
    assert.equal(message.track_clicks, false);
    assert.equal(message.track_opens, false);
  });

  it('falla si Mandrill rechaza el mensaje o responde con error', async () => {
    const rejected = createMailer(CONFIG, memoryLogger().logger, { fetchImpl: fakeFetch(200, [{ status: 'rejected', reject_reason: 'unsigned' }]).impl });
    await assert.rejects(rejected.send({ to: 'a@b.test', subject: 's', text: 't', tag: 'x' }), /rejected/);
    const failed = createMailer(CONFIG, memoryLogger().logger, { fetchImpl: fakeFetch(500, {}).impl });
    await assert.rejects(failed.send({ to: 'a@b.test', subject: 's', text: 't', tag: 'x' }), /500/);
  });

  it('sin API key queda deshabilitado y no registra el contenido', async () => {
    const { logger, lines } = memoryLogger();
    const mailer = createMailer({ enabled: false }, logger);
    assert.equal(mailer.enabled, false);
    await mailer.send({ to: 'ana@empresa.test', subject: 's', text: 'enlace-secreto', tag: 'password-reset' });
    assert.ok(lines.some((line) => line.includes('system mail disabled')));
    assert.ok(!lines.some((line) => line.includes('enlace-secreto') || line.includes('ana@empresa.test')));
  });
});
