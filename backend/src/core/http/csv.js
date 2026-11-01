// CSV for exports (RFC 4180) with protection against CSV injection: a cell
// that a spreadsheet would read as a formula (=, +, -, @, tab, carriage
// return) is prefixed with an apostrophe. Every cell is quoted.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : String(value);
  if (value instanceof Date) text = value.toISOString();
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvLine(values) {
  return `${values.map(csvCell).join(',')}\r\n`;
}

// Byte order mark so spreadsheets open UTF-8 (accents, ñ) correctly.
export const CSV_BOM = '﻿';
