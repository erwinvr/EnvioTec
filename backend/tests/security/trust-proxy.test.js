import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { successSchema } from '../../src/core/http/response.js';
import { PROXY_IP, buildTestApp } from '../helpers/app.js';

const ipRoute = async (app) => {
  const response = { 200: successSchema({ type: 'object', properties: { ip: { type: 'string' } } }) };
  app.get('/api/v1/ip', { config: { public: true }, schema: { response } }, async (request) => ({
    success: true,
    data: { ip: request.ip },
  }));
};

describe('proxy confiable', () => {
  let app;
  before(async () => {
    app = await buildTestApp({ extraPlugins: [ipRoute] });
  });
  after(() => app.close());

  it('ignora X-Forwarded-For si la petición no viene del proxy', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/ip', remoteAddress: '10.9.9.9', headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    assert.equal(res.json().data.ip, '10.9.9.9');
  });

  it('usa X-Forwarded-For solo si la petición viene del proxy', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/ip', remoteAddress: PROXY_IP, headers: { 'x-forwarded-for': '192.168.1.50' },
    });
    assert.equal(res.json().data.ip, '192.168.1.50');
  });
});
