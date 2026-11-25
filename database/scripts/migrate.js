// Usage: node scripts/migrate.js <up | down [count|all] | verify>
//   up      applies every pending migration
//   down    reverts the last migration (or <count>, or all)
//   verify  applies all, reverts all, then applies all again (A11.8)
import { fileURLToPath } from 'node:url';
import { migrate } from './lib/migrator.js';
import { loadToolsConfig, withOwnerDatabase } from './lib/connection.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const config = loadToolsConfig();
const [command, countArg] = process.argv.slice(2);

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

const COMMANDS = {
  up: (db) => migrate(db, MIGRATIONS_DIR, { direction: 'up' }),
  down: (db) => migrate(db, MIGRATIONS_DIR, { direction: 'down', count: parseCount(countArg) }),
  verify: async (db) => {
    await migrate(db, MIGRATIONS_DIR, { direction: 'up' });
    await migrate(db, MIGRATIONS_DIR, { direction: 'down' , count: Infinity });
    await migrate(db, MIGRATIONS_DIR, { direction: 'up' });
    console.log('Las migraciones aplican y revierten correctamente.');
  },
};

if (!COMMANDS[command]) {
  console.error('Uso: node scripts/migrate.js <up | down [count|all] | verify>');
  process.exit(1);
}
try {
  await withOwnerDatabase(config, COMMANDS[command]);
} catch (error) {
  console.error(`Error en las migraciones: ${error.message}`);
  process.exit(1);
}
