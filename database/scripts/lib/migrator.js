import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { lockName, withTransaction } from '../../../backend/src/core/db/transaction.js';

// Versioned migrations for SQL Server (ADR-032), replacing node-pg-migrate.
// Each file NNNNNNNNNNNNNN_name.js exports `up` and `down` as T-SQL text;
// lines with only GO separate batches (CREATE TRIGGER, FUNCTION and
// PROCEDURE must start a batch). Every migration runs in one transaction,
// serialized by an application lock, and is recorded in schema_migrations.

const FILE_PATTERN = /^\d{14}_[a-z0-9-]+\.js$/;
const LOCK = 'enviotec.migrations';

export const splitBatches = (sql) => sql.split(/^\s*GO\s*$/im).map((batch) => batch.trim()).filter(Boolean);

export async function loadMigrations(dir) {
  const files = readdirSync(dir).filter((name) => FILE_PATTERN.test(name)).sort();
  return Promise.all(files.map(async (file) => {
    const module = await import(pathToFileURL(join(dir, file)).href);
    if (typeof module.up !== 'string' || typeof module.down !== 'string') throw new Error(`${file}: must export up and down as strings`);
    return { name: file.replace(/\.js$/, ''), up: module.up, down: module.down };
  }));
}

async function ensureTable(db) {
  await db.query(`IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
    CREATE TABLE dbo.schema_migrations (
      name       nvarchar(200) NOT NULL PRIMARY KEY,
      applied_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
    )`);
}

async function applied(db) {
  const { rows } = await db.query('SELECT name FROM dbo.schema_migrations ORDER BY name');
  return rows.map((row) => row.name);
}

// The applied migrations must be the first ones of the directory, in order:
// a migration added "in the past" is an error, not something to guess.
function checkOrder(done, migrations) {
  done.forEach((name, index) => {
    if (migrations[index]?.name !== name) throw new Error(`migración aplicada fuera de orden o inexistente: ${name}`);
  });
}

async function runOne(db, migration, direction, log) {
  await withTransaction(db, async (client) => {
    await lockName(client, LOCK, { timeoutMs: 60000 });
    for (const batch of splitBatches(migration[direction])) await client.query(batch);
    if (direction === 'up') await client.query('INSERT INTO dbo.schema_migrations (name) VALUES ($1)', [migration.name]);
    else await client.query('DELETE FROM dbo.schema_migrations WHERE name = $1', [migration.name]);
  });
  log(`${direction === 'up' ? 'Aplicada' : 'Revertida'}: ${migration.name}`);
}

export async function migrate(db, dir, { direction, count = Infinity, log = console.log }) {
  await ensureTable(db);
  const migrations = await loadMigrations(dir);
  const done = await applied(db);
  checkOrder(done, migrations);
  const pending = direction === 'up'
    ? migrations.slice(done.length).slice(0, count)
    : migrations.slice(0, done.length).reverse().slice(0, count);
  if (pending.length === 0) log('Sin migraciones pendientes.');
  for (const migration of pending) await runOne(db, migration, direction, log);
  return pending.map((migration) => migration.name);
}
