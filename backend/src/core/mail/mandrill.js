import { Ajv } from 'ajv';

// Mandrill Transactional client for campaigns (ADR-005): native fetch
// through the egress proxy, a timeout on every call, and every response
// validated against a schema before it is trusted. The campaign API key is
// separate from the system mail key.

const ajv = new Ajv({ allErrors: false, removeAdditional: false });
const TIMEOUT_MS = 60000;

export class MandrillError extends Error {
  // definite: the request was answered (nothing was sent); otherwise the
  // outcome is unknown (timeout or connection lost after sending).
  constructor(message, { definite, status = null, name = null } = {}) {
    super(message);
    this.name = 'MandrillError';
    this.definite = definite;
    this.status = status;
    this.mandrillName = name;
  }
}

const sendResult = ajv.compile({
  type: 'array',
  items: {
    type: 'object',
    required: ['email', 'status'],
    properties: {
      email: { type: 'string', maxLength: 254 },
      status: { type: 'string', enum: ['sent', 'queued', 'scheduled', 'rejected', 'invalid'] },
      _id: { type: 'string', maxLength: 100 },
      reject_reason: { type: ['string', 'null'], maxLength: 100 },
    },
  },
});

const searchResult = ajv.compile({
  type: 'array',
  items: {
    type: 'object',
    required: ['_id', 'email', 'state', 'ts'],
    properties: {
      _id: { type: 'string', maxLength: 100 },
      email: { type: 'string', maxLength: 254 },
      state: { type: 'string', maxLength: 30 },
      ts: { type: 'integer' },
      metadata: { type: 'object' },
      opens_detail: { type: 'array', items: { type: 'object', required: ['ts'], properties: { ts: { type: 'integer' } } } },
      clicks_detail: { type: 'array', items: { type: 'object', required: ['ts'], properties: { ts: { type: 'integer' }, url: { type: 'string', maxLength: 2000 } } } },
    },
  },
});

const rejectsResult = ajv.compile({
  type: 'array',
  items: {
    type: 'object',
    required: ['email', 'reason'],
    properties: { email: { type: 'string', maxLength: 254 }, reason: { type: 'string', maxLength: 50 } },
  },
});

export function createMandrill({ apiUrl, apiKey }, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  async function call(path, body, validate) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: apiKey, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MandrillError(`mandrill unreachable: ${error.name}`, { definite: false });
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new MandrillError('mandrill answered something that is not JSON', { definite: response.status >= 400, status: response.status });
    }
    if (!response.ok) {
      throw new MandrillError(`mandrill error ${response.status}`, { definite: true, status: response.status, name: String(data?.name ?? '').slice(0, 50) });
    }
    if (!validate(data)) throw new MandrillError('unexpected mandrill response', { definite: false, status: response.status });
    return data;
  }

  return {
    send: (message) => call('/messages/send', { message, async: false }, sendResult),
    search: ({ query, dateFrom, dateTo, limit = 1000 }) => call('/messages/search', { query, date_from: dateFrom, date_to: dateTo, limit }, searchResult),
    rejects: () => call('/rejects/list', { include_expired: false }, rejectsResult),
  };
}
