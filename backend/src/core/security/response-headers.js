// Headers the backend sets on every response. Browser security headers
// (CSP, HSTS, etc.) are set in a single place: the edge proxy (ADR-001).
export function registerResponseHeaders(app) {
  app.addHook('onSend', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Request-Id', request.id);
  });
}
