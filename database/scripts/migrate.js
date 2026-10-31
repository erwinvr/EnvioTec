// Usage: node scripts/migrate.js <up | down [count|all] | verify>
//   up      applies every pending migration
//   down    reverts the last migration (or <count>, or all)
//   verify  reverts all, then applies all (A11.8: migrations apply and revert)
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { loadToolsConfig } from './lib/connection.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const config = loadToolsConfig();
const [command, countArg] = process.argv.slice(2);

function run(direction, count) {
  return runner({
    databaseUrl: config.migrationDatabaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction,
    count,
    checkOrder: true,
    log: (message) => console.log(message),
  });
}

function parseCount(value) {
  if (value === undefined) return 1;
  if (value === 'all') return Infinity;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    console.error('El número de migraciones debe ser un entero positivo o "all".');
    process.exit(1);
  }
  return count;
}

switch (command) {
  case 'up':
    await run('up', Infinity);
    break;
  case 'down':
    await run('down', parseCount(countArg));
    break;
  case 'verify':
    await run('up', Infinity);
    await run('down', Infinity);
    await run('up', Infinity);
    console.log('Las migraciones aplican y revierten correctamente.');
    break;
  default:
    console.error('Uso: node scripts/migrate.js <up | down [count|all] | verify>');
    process.exit(1);
}
