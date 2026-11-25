// Building blocks for the T-SQL migrations (ADR-032). SQL Server 2022 has no
// regular expressions: format checks are written with LIKE over a binary
// collation (case-sensitive character classes). The application validates
// the same formats first; these are the database's own line of defense.

// BIN2 compares by code point. In a LIKE character class over nvarchar, a
// trailing hyphen is not literal: only() puts it first.
export const BIN = 'COLLATE Latin1_General_BIN2';
// Email addresses: UTF-8 varchar, case-insensitive. LOWER(email) cast to
// varbinary is the UTF-8 of the address, so its SHA-256 matches Node's
// createHash('sha256').update(email.toLowerCase()).
export const EMAIL_TYPE = 'varchar(254) COLLATE Latin1_General_100_CI_AS_SC_UTF8';
export const emailHash = (column) => `CAST(HASHBYTES('SHA2_256', CAST(LOWER(${column}) AS varbinary(1024))) AS varbinary(32))`;
export const NOW = 'SYSUTCDATETIME()';

const WHITESPACE = "N'%[' + NCHAR(32) + NCHAR(9) + NCHAR(10) + NCHAR(11) + NCHAR(12) + NCHAR(13) + N']%'";

// ^[^@\s]+@[^@\s]+$ (or with a dot in the domain: ^[^@\s]+@[^@\s]+\.[^@\s]+$)
export function emailCheck(column, { dot = true } = {}) {
  return `(LEN(${column}) <= 254 AND ${column} LIKE '_%@_%${dot ? '._%' : ''}' AND ${column} NOT LIKE '%@%@%'
    AND ${column} NOT LIKE ${WHITESPACE})`;
}

// Only the given characters (a LIKE character class), with a length range.
export function only(column, chars, min, max) {
  const set = chars.endsWith('-') ? `-${chars.slice(0, -1)}` : chars;
  return `(LEN(${column}) BETWEEN ${min} AND ${max} AND ${column} ${BIN} NOT LIKE '%[^${set}]%')`;
}

// ^[a-z][a-z0-9_]{0,39}$: the technical name of a list variable.
export const variableName = (column) => `(${only(column, 'a-z0-9_', 1, 40)} AND ${column} ${BIN} LIKE '[a-z]%')`;

// ^[a-z][a-z_]*(\.[a-z][a-z_]*)+$: dotted codes (permissions, actions, settings).
export function dottedCode(column, { maxDots = null } = {}) {
  return `(${only(column, 'a-z_.', 3, 100)} AND ${column} ${BIN} LIKE '[a-z]%.[a-z]%'
    AND ${column} NOT LIKE '%..%' AND ${column} NOT LIKE '%.' AND ${column} ${BIN} NOT LIKE '%.[^a-z]%'
    ${maxDots === 1 ? `AND ${column} NOT LIKE '%.%.%'` : ''})`;
}

export const sha256Hex = (column) => only(column, '0-9a-f', 64, 64);
export const noLineBreaks = (column, extra = '') => `${column} NOT LIKE N'%[' + NCHAR(13) + NCHAR(10) + N'${extra}]%'`;
export const isJson = (column, type) => `ISJSON(${column}, ${type}) = 1`;
