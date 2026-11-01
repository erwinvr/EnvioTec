// Verifies the audit hash chain (A7). Exit code 0 if intact, 2 if a row was
// altered, deleted or inserted outside append_audit_log().
//   docker compose run --rm tools node scripts/audit-verify.js [--from 2026-10-01]
import { loadToolsConfig, withOwnerClient } from './lib/connection.js';
import { verifyAuditChain } from './lib/audit-verify.js';

const config = loadToolsConfig();
const fromIndex = process.argv.indexOf('--from');
const from = fromIndex === -1 ? null : process.argv[fromIndex + 1];
if (from !== null && Number.isNaN(Date.parse(from))) {
  console.error('Uso: node scripts/audit-verify.js [--from <fecha ISO 8601>]');
  process.exit(1);
}

const MESSAGES = {
  altered: 'el contenido no coincide con su hash (registro alterado)',
  broken_link: 'no enlaza con el registro anterior (registro eliminado o insertado fuera de la cadena)',
};

const result = await withOwnerClient(config, async (client) => {
  // One consistent snapshot for the whole walk.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    return await verifyAuditChain(client, { from });
  } finally {
    await client.query('ROLLBACK');
  }
});

if (result.problem) {
  console.error(`Cadena de auditoría ROTA en seq ${result.problem.seq} (id ${result.problem.id}): `
    + `${MESSAGES[result.problem.reason]}. Registros válidos antes del problema: ${result.checked}.`);
  process.exit(2);
}
console.log(result.checked === 0
  ? 'Cadena de auditoría: no hay registros que verificar.'
  : `Cadena de auditoría íntegra: ${result.checked} registros (seq ${result.firstSeq} a ${result.lastSeq}).`);
