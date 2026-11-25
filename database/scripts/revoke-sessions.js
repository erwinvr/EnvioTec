// Revokes every active session, or those of one user (runbook):
//   docker compose run --rm tools node scripts/revoke-sessions.js --reason "Incidente 2026-11"
//   docker compose run --rm tools node scripts/revoke-sessions.js --reason "Cuenta comprometida" --user <uuid>
import { inLockedTransaction, loadToolsConfig, withOwnerDatabase } from './lib/connection.js';
import { revokeSessions } from './lib/revoke-sessions.js';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const reason = argument('--reason');
const userId = argument('--user');
if (!reason || (userId !== null && !/^[0-9a-f-]{36}$/i.test(userId))) {
  console.error('Uso: node scripts/revoke-sessions.js --reason "<motivo>" [--user <uuid>]');
  process.exit(1);
}

try {
  const config = loadToolsConfig();
  const result = await withOwnerDatabase(config, (db) =>
    inLockedTransaction(db, 'enviotec.revoke_sessions', (client) => revokeSessions(client, { reason, userId })));
  console.log(`Sesiones revocadas: ${result.sessions}. Cada usuario deberá iniciar sesión de nuevo.`);
} catch (error) {
  console.error(`No se revocaron sesiones: ${error.message}`);
  process.exit(2);
}
