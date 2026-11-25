import sql from 'mssql';
import { connectionOptions } from './connection-url.js';
import { normalizeError } from './errors.js';

// SQL Server access (ADR-032). Repositories keep a small, driver-neutral
// interface:
//   db.query(text, params) -> { rows, rowCount }
//   db.connect() -> client with begin(), commit(), rollback(), query(), release()
// Placeholders are written as $1, $2... and always travel as parameters (A8);
// they become @p1, @p2... here. Values are typed from their JavaScript type.

const CONNECTION_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30000;
const MAX_NVARCHAR = 4000;

// Columns stored as JSON text (NVARCHAR(MAX) with ISJSON): returned parsed,
// as the PostgreSQL jsonb and array columns were. A column (or alias) with
// one of these names always holds JSON.
export const JSON_COLUMNS = new Set([
  'metadata', 'value', 'attributes', 'attribute_labels', 'attribute_types', 'errors', 'header', 'sample',
  'mapping', 'images', 'variables', 'roles', 'permissions', 'types', 'list_attributes', 'list_types',
]);

// A value bound with an explicit type: binary(null) for a nullable
// VARBINARY column (a NULL typed as text does not convert to binary).
export const typed = (type, value) => ({ [TYPED]: true, type, value });
export const binary = (value) => typed(sql.VarBinary(sql.MAX), value ?? null);
const TYPED = Symbol('typed');

function bind(request, index, value) {
  const name = `p${index + 1}`;
  if (value !== null && typeof value === 'object' && value[TYPED]) return request.input(name, value.type, value.value);
  if (value === undefined || value === null) return request.input(name, sql.NVarChar(MAX_NVARCHAR), null);
  if (Buffer.isBuffer(value)) return request.input(name, sql.VarBinary(sql.MAX), value);
  if (value instanceof Date) return request.input(name, sql.DateTime2(3), value);
  if (typeof value === 'boolean') return request.input(name, sql.Bit, value);
  if (typeof value === 'bigint') return request.input(name, sql.BigInt, value.toString());
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return request.input(name, Math.abs(value) <= 2147483647 ? sql.Int : sql.BigInt, value);
    return request.input(name, sql.Float, value);
  }
  if (typeof value === 'object') return request.input(name, sql.NVarChar(sql.MAX), JSON.stringify(value));
  const text = String(value);
  return request.input(name, sql.NVarChar(text.length > MAX_NVARCHAR ? sql.MAX : MAX_NVARCHAR), text);
}

export const toTsql = (text) => text.replace(/\$(\d+)/g, '@p$1');

function normalizeRows(recordset) {
  if (!recordset) return [];
  const columns = recordset.columns ?? {};
  const uuids = Object.keys(columns).filter((name) => columns[name].type === sql.UniqueIdentifier);
  const json = Object.keys(columns).filter((name) => JSON_COLUMNS.has(name));
  if (uuids.length === 0 && json.length === 0) return recordset;
  for (const row of recordset) {
    for (const name of uuids) if (typeof row[name] === 'string') row[name] = row[name].toLowerCase();
    for (const name of json) if (typeof row[name] === 'string') row[name] = JSON.parse(row[name]);
  }
  return recordset;
}

async function run(request, text, params = []) {
  params.forEach((value, index) => bind(request, index, value));
  try {
    const result = await request.query(toTsql(text));
    const rows = normalizeRows(result.recordsets?.length ? result.recordsets.at(-1) : result.recordset);
    return { rows: [...rows], rowCount: result.rowsAffected.length ? result.rowsAffected.at(-1) : rows.length };
  } catch (error) {
    throw normalizeError(error);
  }
}

// One connection inside a transaction: begin() takes a connection from the
// pool and keeps it until commit() or rollback().
function createClient(pool) {
  let transaction = null;
  return {
    // 'snapshot': one consistent view for the whole transaction (needs
    // ALLOW_SNAPSHOT_ISOLATION, set by provisioning).
    async begin(isolation = 'read_committed') {
      transaction = new sql.Transaction(pool);
      try {
        await transaction.begin(isolation === 'snapshot' ? sql.ISOLATION_LEVEL.SNAPSHOT : sql.ISOLATION_LEVEL.READ_COMMITTED);
      } catch (error) {
        transaction = null;
        throw normalizeError(error);
      }
    },
    query(text, params) {
      if (!transaction) throw new Error('client.query() requires begin()');
      return run(new sql.Request(transaction), text, params);
    },
    async commit() {
      const current = transaction;
      transaction = null;
      await current.commit();
    },
    async rollback() {
      const current = transaction;
      transaction = null;
      // A server-side error may already have rolled the transaction back.
      if (current && !current._aborted) await current.rollback().catch(() => {});
    },
    release() {
      if (transaction) this.rollback();
    },
  };
}

export function createDatabase(pool) {
  return {
    query: (text, params) => run(pool.request(), text, params),
    connect: async () => createClient(pool),
    end: () => pool.close(),
    pool,
  };
}

// A database from explicit connection options (provisioning, tests).
export async function connectDatabase(options) {
  const pool = new sql.ConnectionPool(options);
  await pool.connect();
  return createDatabase(pool);
}

export async function createPool(databaseConfig, logger, applicationName) {
  const pool = new sql.ConnectionPool({
    ...connectionOptions(databaseConfig, applicationName),
    requestTimeout: databaseConfig.statementTimeoutMs,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    pool: { max: databaseConfig.poolMax, min: 0, idleTimeoutMillis: IDLE_TIMEOUT_MS },
  });
  pool.on('error', (error) => logger.error({ err: error }, 'sql server pool error'));
  await pool.connect();
  return createDatabase(pool);
}
