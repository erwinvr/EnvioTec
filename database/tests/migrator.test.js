// The migration runner (ADR-032): batches split by GO, and the history
// table agrees with the migrations directory.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMigrations, splitBatches } from '../scripts/lib/migrator.js';
import { connect } from './helpers.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('migraciones', () => {
  let owner;
  before(async () => {
    owner = await connect('owner');
  });
  after(() => owner.end());

  it('separa los lotes por GO (una línea con solo GO, sin distinguir mayúsculas)', () => {
    assert.deepEqual(splitBatches('CREATE TABLE a (x int);\nGO\nCREATE TRIGGER t ON a AFTER INSERT AS SELECT 1\n  go  \n\n'),
      ['CREATE TABLE a (x int);', 'CREATE TRIGGER t ON a AFTER INSERT AS SELECT 1']);
    assert.deepEqual(splitBatches('SELECT 1 AS GOAL'), ['SELECT 1 AS GOAL']);
  });

  it('cada migración tiene up y down, y todas están aplicadas en orden', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    assert.ok(migrations.length > 0);
    for (const migration of migrations) assert.ok(migration.up.length > 0 && migration.down.length > 0, migration.name);
    const { rows } = await owner.query('SELECT name FROM dbo.schema_migrations ORDER BY name');
    assert.deepEqual(rows.map((row) => row.name), migrations.map((migration) => migration.name));
  });

  it('la base usa read committed snapshot y aislamiento snapshot', async () => {
    const { rows } = await owner.query(
      'SELECT is_read_committed_snapshot_on AS rcsi, snapshot_isolation_state AS snapshot FROM sys.databases WHERE name = DB_NAME()',
    );
    assert.deepEqual([rows[0].rcsi, rows[0].snapshot], [true, 1]);
  });
});
