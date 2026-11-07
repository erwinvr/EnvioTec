import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMandrill, MandrillError } from '../../src/core/mail/mandrill.js';
import { buildMessage, escapeHtml, recipientValues, toMergeHtml, toMergeText } from '../../src/modules/sending/message.js';
import { eventKey, eventsOf } from '../../src/modules/sending/sync.service.js';
import { describeAgent } from '../../src/modules/sending/user-agent.js';

describe('armado del mensaje (ADR-013, ADR-024)', () => {
  it('las variables se escapan una sola vez, en EnvioTec', () => {
    assert.equal(toMergeHtml('<p>Hola {{ first_name }}, {{plan}}</p>'), '<p>Hola {{{first_name}}}, {{{plan}}}</p>');
    assert.equal(toMergeText('Hola {{first_name}}'), 'Hola {{{first_name__text}}}');
    assert.equal(escapeHtml(`<script>"x"&'y'`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
    const values = recipientValues({ email: 'a@b.test', first_name: '<b>Ana</b> & Co', last_name: null, attributes: { plan: 'Oro\u0007' } }, ['first_name', 'plan']);
    assert.deepEqual(values, [
      { name: 'first_name', content: '&lt;b&gt;Ana&lt;/b&gt; &amp; Co' },
      { name: 'first_name__text', content: '<b>Ana</b> & Co' },
      { name: 'plan', content: 'Oro' },
      { name: 'plan__text', content: 'Oro' },
    ]);
  });

  it('un lote: un mensaje por destinatario sin mostrar a los demás, PDF y metadatos para cruzar eventos', () => {
    const message = buildMessage({
      campaignId: 'c1', batchId: 'b1', subject: 'Asunto',
      content: { html: '<p>{{first_name}}</p><img src="cid:img1@enviotec">', text: '{{first_name}}', variables: ['first_name'], images: [{ cid: 'img1@enviotec', contentType: 'image/png', base64: 'AA==' }] },
      sender: { email: 'ventas@envios.test', display_name: 'Ventas', reply_to: 'ventas@empresa.test' },
      attachment: { name: 'folleto.pdf', base64: 'JVBERi0=' },
      recipients: [{ id: 'r1', email: 'uno@x.test', first_name: 'Uno', attributes: {} }, { id: 'r2', email: 'dos@x.test', first_name: 'Dos', attributes: {} }],
    });
    assert.equal(message.preserve_recipients, false);
    assert.equal(message.merge_language, 'handlebars');
    assert.deepEqual(message.metadata, { campaign_id: 'c1', batch_id: 'b1' });
    assert.deepEqual(message.recipient_metadata[1], { rcpt: 'dos@x.test', values: { recipient_id: 'r2' } });
    assert.equal(message.attachments[0].type, 'application/pdf');
    assert.equal(message.images[0].name, 'img1@enviotec');
    assert.deepEqual(message.headers, { 'Reply-To': 'ventas@empresa.test' });
    assert.equal(message.auto_text, false);
  });
});

describe('cliente de Mandrill', () => {
  const respond = (status, data) => async () => ({ ok: status < 400, status, json: async () => data });

  it('valida cada respuesta con su schema y distingue errores definitivos de resultados inciertos', async () => {
    const ok = createMandrill({ apiUrl: 'https://m.test', apiKey: 'k' }, { fetchImpl: respond(200, [{ email: 'a@b.test', status: 'sent', _id: 'x' }]) });
    assert.equal((await ok.send({}))[0].status, 'sent');
    const weird = createMandrill({ apiUrl: 'https://m.test', apiKey: 'k' }, { fetchImpl: respond(200, { unexpected: true }) });
    await assert.rejects(weird.send({}), (e) => e instanceof MandrillError && e.definite === false);
    const error = createMandrill({ apiUrl: 'https://m.test', apiKey: 'k' }, { fetchImpl: respond(500, { name: 'Invalid_Key' }) });
    await assert.rejects(error.send({}), (e) => e.definite === true && e.mandrillName === 'Invalid_Key');
    const down = createMandrill({ apiUrl: 'https://m.test', apiKey: 'k' }, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(down.send({}), (e) => e.definite === false);
  });
});

describe('eventos de seguimiento', () => {
  it('estado, aperturas y clics de un mensaje, con clave idempotente', () => {
    const events = eventsOf({ _id: 'm1', state: 'bounced', ts: 100, opens_detail: [{ ts: 101 }], clicks_detail: [{ ts: 102, url: 'https://x.test' }] });
    assert.deepEqual(events.map((e) => e.type), ['hard_bounce', 'open', 'click']);
    assert.deepEqual(eventKey('m1', 'open', 101), eventKey('m1', 'open', 101));
    assert.notDeepEqual(eventKey('m1', 'open', 101), eventKey('m1', 'open', 102));
    assert.deepEqual(eventsOf({ _id: 'm2', state: 'desconocido', ts: 1 }), []);
  });
});

describe('detalle de aperturas y clics (ADR-029)', () => {
  it('dispositivo, sistema y programa desde el user agent; proxys de imágenes identificados', () => {
    assert.deepEqual(describeAgent({ ua: null, ip: '74.125.1.2' }), { device: 'proxy', os: null, client: 'Gmail (proxy de imágenes)' });
    assert.deepEqual(describeAgent({ ua: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', ip: '1.1.1.1' }),
      { device: 'desktop', os: 'Windows', client: 'Chrome' });
    assert.deepEqual(describeAgent({ ua: 'Mozilla/5.0 (Linux; Android 14) Mobile', ip: null }), { device: 'mobile', os: 'Android', client: null });
    assert.equal(describeAgent({ ua: 'Microsoft Outlook 16.0', ip: null }).client, 'Outlook');
    assert.equal(describeAgent({ ua: 'YahooMailProxy; https://help.yahoo.com', ip: null }).device, 'proxy');
    assert.deepEqual(describeAgent({ ua: null, ip: '200.1.1.1' }), { device: null, os: null, client: null });
    const [, open] = eventsOf({ _id: 'm', state: 'sent', ts: 1, opens_detail: [{ ts: 2, ip: '200.1.1.1', location: 'La Paz, BO', ua: 'Mozilla/5.0 (iPad)' }] });
    assert.deepEqual(open, { type: 'open', ts: 2, ip: '200.1.1.1', location: 'La Paz, BO', userAgent: 'Mozilla/5.0 (iPad)', device: 'tablet', os: 'iOS', client: null });
  });
});
