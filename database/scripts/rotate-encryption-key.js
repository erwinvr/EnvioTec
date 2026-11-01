// Rotation of DATA_ENCRYPTION_KEY (runbook, section "Rotación de secretos").
// Run with backend and worker stopped; both key files are mounted read-only:
//   docker compose run --rm -v /ruta/actual:/run/keys/old:ro -v /ruta/nueva:/run/keys/new:ro \
//     tools node scripts/rotate-encryption-key.js --old /run/keys/old --new /run/keys/new
// Then replace the data_encryption_key secret with the new file and start
// the services again.
import { readFileSync } from 'node:fs';
import { inLockedTransaction, loadToolsConfig, withOwnerClient } from './lib/connection.js';
import { parseKey, rotateEncryptionKey } from './lib/rotate-key.js';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const oldFile = argument('--old');
const newFile = argument('--new');
if (!oldFile || !newFile) {
  console.error('Uso: node scripts/rotate-encryption-key.js --old <archivo de la clave actual> --new <archivo de la clave nueva>');
  process.exit(1);
}

try {
  const oldKey = parseKey(readFileSync(oldFile, 'utf8'), '--old');
  const newKey = parseKey(readFileSync(newFile, 'utf8'), '--new');
  const config = loadToolsConfig();
  const result = await withOwnerClient(config, (client) => inLockedTransaction(client, 'enviotec.key_rotation', () => rotateEncryptionKey(client, { oldKey, newKey })));
  console.log(`Clave rotada: ${result.secrets} secretos MFA cifrados con la clave nueva. Reemplace el secret data_encryption_key y vuelva a iniciar backend y worker.`);
} catch (error) {
  console.error(`No se rotó la clave: ${error.message}`);
  process.exit(2);
}
