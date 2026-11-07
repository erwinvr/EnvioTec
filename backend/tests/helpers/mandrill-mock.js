import { randomUUID } from 'node:crypto';
import http from 'node:http';

// In-process double of the Mandrill API for tests (ADR-024): records what is
// sent and answers like Mandrill. `mode` simulates failures:
//   'ok'        every recipient sent (except state.reject)
//   'error'     500 with a Mandrill error body (definite: nothing sent)
//   'hang'      the request is accepted and never answered (unknown outcome)
// `indexed: false` makes the metadata search find nothing, as in an account
// without indexed custom metadata (ADR-029); search by email and info work.
export async function startMandrillMock() {
  const state = { mode: 'ok', indexed: true, reject: new Set(), sent: [], messages: [], rejects: [], requests: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    state.requests.push({ path: req.url, body });
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (body.key !== 'clave-de-campanias-de-prueba') return reply(500, { status: 'error', name: 'Invalid_Key', message: 'Invalid API key' });
    if (req.url === '/messages/send') {
      if (state.mode === 'error') return reply(500, { status: 'error', name: 'GeneralError', message: 'boom' });
      const results = body.message.to.map(({ email }) => {
        const id = randomUUID().replaceAll('-', '');
        const meta = body.message.recipient_metadata.find((m) => m.rcpt === email)?.values ?? {};
        if (state.reject.has(email)) return { email, status: 'rejected', _id: id, reject_reason: 'hard-bounce' };
        state.messages.push({ _id: id, email, state: 'sent', ts: Math.floor(Date.now() / 1000), metadata: { ...body.message.metadata, ...meta }, opens_detail: [], clicks_detail: [] });
        return { email, status: 'sent', _id: id };
      });
      state.sent.push(body.message);
      if (state.mode === 'hang') return undefined;
      return reply(200, results);
    }
    if (req.url === '/messages/search') {
      const byEmail = /^email:(\S+)$/.exec(body.query);
      if (byEmail) return reply(200, state.messages.filter((m) => m.email === byEmail[1].toLowerCase()).slice(0, body.limit ?? 100));
      const [, field, value] = /^u_([a-z_]+):"([^"]+)"$/.exec(body.query) ?? [];
      if (!state.indexed) return reply(200, []);
      return reply(200, state.messages.filter((m) => m.metadata[field] === value).slice(0, body.limit ?? 100));
    }
    if (req.url === '/messages/info') {
      const message = state.messages.find((m) => m._id === body.id);
      return message ? reply(200, message) : reply(500, { status: 'error', name: 'Unknown_Message', message: 'No message exists' });
    }
    if (req.url === '/rejects/list') return reply(200, state.rejects);
    return reply(404, { status: 'error', name: 'Unknown_Method' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    config: { apiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'clave-de-campanias-de-prueba', enabled: true, batchSize: 2 },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
