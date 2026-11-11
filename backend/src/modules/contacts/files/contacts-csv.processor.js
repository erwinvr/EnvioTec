import { once } from 'node:events';
import { parse } from 'csv-parse';
import { detectDelimiter, LIMITS, previewCells, validateMapping, validateRow } from '../csv-rows.js';

// Inspection of an uploaded contacts CSV inside the file-processor
// (ADR-004), in two jobs (ADR-028):
//   preview  antivirus, then the header and a small sample for the user to
//            map columns; the upload stays in quarantine for the import
//   import   streaming parse with the confirmed mapping and per-row
//            validation; valid rows go to results/<fileId> as JSON lines
// The original upload is deleted once there is a final outcome; a thrown
// error (for example ClamAV unreachable) keeps it for the retry.

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

function records(store, fileId, delimiter) {
  return store.read('incoming', fileId).pipe(parse({
    bom: true, delimiter, relax_column_count: true, skip_empty_lines: true, max_record_size: 64 * 1024, relax_quotes: false,
  }));
}

export async function processContactsCsvPreview(data, deps) {
  const outcome = await preview(data, deps);
  if (outcome.status !== 'ok') await deps.store.remove('incoming', data.fileId);
  return outcome;
}

async function preview({ fileId }, { store, clamav }) {
  const scan = await clamav.scan(store.read('incoming', fileId));
  if (!scan.clean) return { status: 'failed', reason: 'malware', signature: scan.signature };
  const line = await firstLine(store, fileId);
  // A CSV is text: a NUL byte means a binary file with a .csv name.
  if (line.includes('\u0000')) return { status: 'failed', reason: 'not_text' };
  const parser = records(store, fileId, detectDelimiter(line));
  let header = null;
  const sample = [];
  try {
    for await (const record of parser) {
      if (header === null) {
        if (record.length > LIMITS.maxColumns) return { status: 'failed', reason: 'too_many_columns' };
        header = previewCells(record);
        continue;
      }
      sample.push(previewCells(record));
      if (sample.length === LIMITS.sampleRows) break;
    }
  } catch {
    return { status: 'failed', reason: 'invalid_csv' };
  } finally {
    parser.destroy();
  }
  if (header === null) return { status: 'failed', reason: 'empty_file' };
  return { status: 'ok', header, sample };
}

export async function processContactsCsv(data, deps) {
  const outcome = await inspect(data, deps);
  await deps.store.remove('incoming', data.fileId);
  return outcome;
}

async function inspect({ fileId, mapping, attributes, types = {} }, { store, clamav }) {
  const scan = await clamav.scan(store.read('incoming', fileId));
  if (!scan.clean) return { status: 'failed', reason: 'malware', signature: scan.signature };

  const line = await firstLine(store, fileId);
  if (line.includes('\u0000')) return { status: 'failed', reason: 'not_text' };
  const parser = records(store, fileId, detectDelimiter(line));
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
        // The mapping was checked by the backend; checked again here against
        // the real header, in case the file and the mapping do not match.
        const checked = validateMapping(mapping, previewCells(record), attributes);
        if (checked.error) return { status: 'failed', reason: checked.error };
        columns = checked.columns;
        continue;
      }
      rowNumber += 1;
      totalRows += 1;
      if (totalRows > LIMITS.maxRows) return { status: 'failed', reason: 'too_many_rows' };
      const result = validateRow(record, columns, types);
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
