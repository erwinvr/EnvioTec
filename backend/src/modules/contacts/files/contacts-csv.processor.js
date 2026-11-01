import { once } from 'node:events';
import { parse } from 'csv-parse';
import { detectDelimiter, LIMITS, validateHeader, validateRow } from '../csv-rows.js';

// Inspection of an uploaded contacts CSV inside the file-processor
// (ADR-004): antivirus first, then streaming parse and per-row validation.
// Valid rows go to results/<fileId> as JSON lines for the worker; the
// original upload is deleted once there is an outcome; a thrown error (for
// example ClamAV unreachable) keeps it for the retry.

async function firstLine(store, fileId) {
  const stream = store.read('incoming', fileId);
  let text = '';
  for await (const chunk of stream) {
    text += chunk.toString('utf8');
    if (text.includes('\n') || text.length > 8192) break;
  }
  stream.destroy();
  return text.split(/\r?\n/)[0] ?? '';
}

export async function processContactsCsv(data, deps) {
  const outcome = await inspect(data, deps);
  await deps.store.remove('incoming', data.fileId);
  return outcome;
}

async function inspect({ fileId, attributes }, { store, clamav }) {
  const scan = await clamav.scan(store.read('incoming', fileId));
  if (!scan.clean) return { status: 'failed', reason: 'malware', signature: scan.signature };

  const header = await firstLine(store, fileId);
  // A CSV is text: a NUL byte means a binary file with a .csv name.
  if (header.includes('\u0000')) return { status: 'failed', reason: 'not_text' };
  const delimiter = detectDelimiter(header);
  const parser = store.read('incoming', fileId).pipe(parse({
    bom: true, delimiter, relax_column_count: true, skip_empty_lines: true, max_record_size: 64 * 1024, relax_quotes: false,
  }));
  const output = await store.writer('results', fileId);
  const seen = new Set();
  const errors = [];
  let columns = null;
  let rowNumber = 1;
  let totalRows = 0;
  let valid = 0;
  let rejected = 0;
  const reject = (row, field, code) => {
    rejected += 1;
    if (errors.length < LIMITS.maxErrors) errors.push({ row, field, code });
  };

  try {
    for await (const record of parser) {
      if (columns === null) {
        const checked = validateHeader(record, attributes);
        if (checked.error) return { status: 'failed', reason: checked.error, columns: checked.columns ?? [] };
        columns = checked.columns;
        continue;
      }
      rowNumber += 1;
      totalRows += 1;
      if (totalRows > LIMITS.maxRows) return { status: 'failed', reason: 'too_many_rows' };
      const result = validateRow(record, columns);
      if (result.problems) {
        for (const problem of result.problems) reject(rowNumber, problem.field, problem.code);
        continue;
      }
      if (seen.has(result.contact.email)) {
        reject(rowNumber, 'email', 'duplicate_in_file');
        continue;
      }
      seen.add(result.contact.email);
      valid += 1;
      if (!output.write(`${JSON.stringify(result.contact)}\n`)) await once(output, 'drain');
    }
  } catch {
    return { status: 'failed', reason: 'invalid_csv', row: rowNumber + 1 };
  } finally {
    output.end();
    await once(output, 'close').catch(() => {});
  }
  if (columns === null) return { status: 'failed', reason: 'empty_file' };
  return { status: 'ok', totalRows, valid, rejected, errors };
}
