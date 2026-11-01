// Single API client (A9): same-origin cookies, the session's CSRF token on
// state-changing requests, a timeout, and errors in the backend's format.

const TIMEOUT_MS = 15000;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token ?? null;
}

export class ApiError extends Error {
  constructor({ status, code, message, details = [], requestId = null, retryAfter = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

export function buildUrl(path, query = {}) {
  const url = new URL(path, 'https://placeholder.invalid');
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export async function toApiError(response) {
  const body = await response.json().catch(() => null);
  const error = body?.error ?? {};
  return new ApiError({
    status: response.status,
    code: error.code ?? (response.status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
    message: error.message ?? '',
    details: Array.isArray(error.details) ? error.details : [],
    requestId: error.requestId ?? response.headers.get('x-request-id'),
    retryAfter: Number(response.headers.get('retry-after')) || null,
  });
}

// Returns the parsed body ({ data, meta }) or, with { raw: true }, the
// Response itself (CSV downloads).
export async function request(method, path, { body, form, query, raw = false, fetchImpl = fetch } = {}) {
  const headers = { accept: raw ? '*/*' : 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  // FormData: the browser sets multipart/form-data with its boundary.
  if (!SAFE_METHODS.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;
  let response;
  try {
    response = await fetchImpl(buildUrl(path, query), {
      method,
      headers,
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: '' });
  }
  if (!response.ok) throw await toApiError(response);
  if (raw) return response;
  return response.json();
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body = {}) => request('POST', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  delete: (path) => request('DELETE', path),
  download: (path, query) => request('GET', path, { query, raw: true }),
  upload: (path, file) => {
    const form = new FormData();
    form.append('file', file);
    return request('POST', path, { form });
  },
};
