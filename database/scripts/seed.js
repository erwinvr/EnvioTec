// Usage: node scripts/seed.js <system | dev>
//   system  permission catalog, initial roles and system parameters (every environment)
//   dev     sample data for development only; refuses to run with NODE_ENV=production
import { AREAS } from '../seeds/dev/areas.js';
import { inLockedTransaction, loadToolsConfig, withOwnerDatabase } from './lib/connection.js';
import { seedSystem } from './lib/seed-system.js';

const config = loadToolsConfig();
const kind = process.argv[2];

async function seedDev(client) {
  let created = 0;
  for (const area of AREAS) {
    const { rows } = await client.query(
      `IF NOT EXISTS (SELECT 1 FROM areas WITH (UPDLOCK, HOLDLOCK) WHERE name = $1)
       BEGIN INSERT INTO areas (name, ad_department) VALUES ($1, $2); SELECT 1 AS created; END
       ELSE SELECT 0 AS created;`,
      [area.name, area.adDepartment],
    );
    created += rows[0].created;
  }
  return { areas: created };
}

if (kind === 'system') {
  const result = await withOwnerDatabase(config, (db) =>
    inLockedTransaction(db, 'enviotec.seed', (client) => seedSystem(client)));
  console.log(`Seed de sistema aplicado: ${result.permissions} permisos creados o actualizados, `
    + `${result.roles} roles creados, ${result.settings} parámetros creados o actualizados.`);
} else if (kind === 'dev') {
  if (config.env === 'production') {
    console.error('El seed de desarrollo no se ejecuta con NODE_ENV=production.');
    process.exit(1);
  }
  const result = await withOwnerDatabase(config, (db) =>
    inLockedTransaction(db, 'enviotec.seed', (client) => seedDev(client)));
  console.log(`Seed de desarrollo aplicado: ${result.areas} áreas creadas.`);
} else {
  console.error('Uso: node scripts/seed.js <system | dev>');
  process.exit(1);
}
