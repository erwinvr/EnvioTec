// Shared helpers for the Mandrill spike (phase 0.5). Not production code.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://mandrillapp.com/api/1.0';
const TIMEOUT_MS = 30_000;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`Falta la variable de entorno ${name}. Ver spikes/mandrill/README.md`);
    process.exit(1);
  }
  return value.trim();
}

// Calls a Mandrill endpoint. The key is read from the environment and never
// returned, logged or saved.
export async function callApi(path, params = {}) {
  const key = requireEnv('MANDRILL_API_KEY');
  const startedAt = Date.now();
  const response = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, ...params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsed: text.slice(0, 2000) };
  }
  return { path, httpStatus: response.status, durationMs: Date.now() - startedAt, body };
}

// Saves a result under out/ (ignored by Git). Results may contain test
// mailbox addresses; sanitize them before copying anything into docs/.
export async function saveResult(name, data) {
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUT_DIR, `${stamp}-${name}.json`);
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(`Resultado guardado en ${file}`);
  return file;
}

export function isApiError(result) {
  return result.httpStatus !== 200 || result.body?.status === 'error';
}
