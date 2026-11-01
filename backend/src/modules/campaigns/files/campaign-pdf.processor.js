import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forbiddenNames, isPdfSignature, MAX_BYTES } from '../pdf-rules.js';

// Inspection of the campaign PDF inside the file-processor (Parte B,
// ADR-004): antivirus, signature %PDF, size, no encryption, normalization
// with qpdf (rejected if qpdf cannot read it) and, on the normalized copy,
// no JavaScript, automatic actions, launches or embedded files. The
// original (not the normalized copy) is what gets sent.

const QPDF_TIMEOUT_MS = 60000;

function qpdf(args) {
  return new Promise((resolve) => {
    execFile('qpdf', args, { timeout: QPDF_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error) => {
      resolve(error ? (typeof error.code === 'number' ? error.code : -1) : 0);
    });
  });
}

export async function processCampaignPdf(data, deps) {
  const outcome = await inspect(data, deps);
  if (outcome.status === 'ok') await deps.store.move('incoming', 'results', data.fileId);
  else await deps.store.remove('incoming', data.fileId);
  return outcome;
}

async function inspect({ fileId }, { store, clamav }) {
  const scan = await clamav.scan(store.read('incoming', fileId));
  if (!scan.clean) return { status: 'failed', reason: 'malware', signature: scan.signature };
  if (await store.size('incoming', fileId) > MAX_BYTES) return { status: 'failed', reason: 'too_large' };
  const source = store.pathOf('incoming', fileId);
  const head = await readFile(source).then((buffer) => buffer.subarray(0, 8));
  if (!isPdfSignature(head)) return { status: 'failed', reason: 'not_pdf' };

  // --is-encrypted: exit 0 when encrypted, 2 when not.
  const encrypted = await qpdf(['--is-encrypted', source]);
  if (encrypted === 0) return { status: 'failed', reason: 'encrypted' };
  if (encrypted !== 2) return { status: 'failed', reason: 'invalid_pdf' };

  const normalized = join(tmpdir(), `${fileId}.qdf`);
  try {
    // Exit 3 means warnings with a usable result; anything else is rejected.
    const code = await qpdf(['--qdf', '--object-streams=disable', '--decode-level=generalized', source, normalized]);
    if (code !== 0 && code !== 3) return { status: 'failed', reason: 'invalid_pdf' };
    const found = forbiddenNames((await readFile(normalized)).toString('latin1'));
    if (found.length > 0) return { status: 'failed', reason: 'active_content', detail: found.slice(0, 10) };
  } finally {
    await rm(normalized, { force: true });
  }
  return { status: 'ok' };
}
