// Helpers for parameterized SQL (A8). Values always travel as parameters;
// these only prepare a value for a given operator.

// A search term for LIKE ... ESCAPE '\', matched literally: %, _, [ and \
// lose their meaning. Text columns use a case-insensitive collation, so LIKE
// does what ILIKE did.
export const escapeLike = (text) => text.replace(/[\\%_[]/g, (char) => `\\${char}`);

// SQL Server forbids a bare OUTPUT clause on a table with triggers (the guard
// triggers of users, roles, role assignments, suppressions...): the returned
// columns go through a table variable. `columns` maps each name to its T-SQL
// type; `source` is "inserted" (INSERT, UPDATE) or "deleted" (DELETE).
//   const out = returning({ id: 'uniqueidentifier' });
//   `${out.declare} INSERT INTO roles (...) ${out.output} VALUES (...); ${out.select}`
export function returning(columns, { source = 'inserted' } = {}) {
  const names = Object.keys(columns);
  return {
    declare: `DECLARE @out TABLE (${names.map((name) => `${name} ${columns[name]}`).join(', ')});`,
    output: `OUTPUT ${names.map((name) => `${source}.${name}`).join(', ')} INTO @out`,
    select: `SELECT ${names.join(', ')} FROM @out;`,
  };
}

// EXISTS (...) as a bit column of the select list.
export const existsBit = (subquery) => `CAST(CASE WHEN EXISTS (${subquery}) THEN 1 ELSE 0 END AS bit)`;

// A JSON array of strings aggregated in a subquery (array_agg in PostgreSQL):
//   (SELECT ${jsonStrings('p.code')} FROM ...) AS permissions
// Returns '[]' when there are no rows. Name the column after one of the
// adapter's JSON_COLUMNS so it arrives parsed.
export const jsonStrings = (expression, orderBy = expression) =>
  `COALESCE(N'[' + STRING_AGG(CAST(N'"' + STRING_ESCAPE(${expression}, 'json') + N'"' AS nvarchar(max)), N',') WITHIN GROUP (ORDER BY ${orderBy}) + N']', N'[]')`;

// Rows of a JSON array parameter (= ANY($n) in PostgreSQL):
//   WHERE p.code IN ${inJson('$2')}
export const inJson = (placeholder) => `(SELECT value FROM OPENJSON(${placeholder}))`;

// America/La_Paz (UTC-4, no daylight saving) as SQL Server names it. Times
// are stored in UTC (datetime2); these convert for calendar logic.
const LA_PAZ = "'SA Western Standard Time'";
export const toLaPaz = (utc) => `CAST(CAST(${utc} AS datetime2(3)) AT TIME ZONE 'UTC' AT TIME ZONE ${LA_PAZ} AS datetime2(3))`;
export const fromLaPaz = (local) => `CAST(CAST(${local} AS datetime2(3)) AT TIME ZONE ${LA_PAZ} AT TIME ZONE 'UTC' AS datetime2(3))`;
export const LA_PAZ_NOW = toLaPaz('SYSUTCDATETIME()');
export const LA_PAZ_TODAY = `CAST(${LA_PAZ_NOW} AS date)`;
export const LA_PAZ_MONTH = `DATEFROMPARTS(YEAR(${LA_PAZ_NOW}), MONTH(${LA_PAZ_NOW}), 1)`;
// A date as YYYY-MM-DD text (to_char(..., 'YYYY-MM-DD')).
export const isoDate = (expression) => `CONVERT(char(10), ${expression}, 23)`;

// Paging after ORDER BY (LIMIT/OFFSET in PostgreSQL).
export const page = (offsetPlaceholder, limitPlaceholder) => `OFFSET ${offsetPlaceholder} ROWS FETCH NEXT ${limitPlaceholder} ROWS ONLY`;
