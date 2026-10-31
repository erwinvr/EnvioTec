// Creates the initial superadmin (or, with --emergency, the emergency account).
//
// Interactive (recommended):
//   docker compose run --rm tools node scripts/bootstrap-admin.js
// Non-interactive (automation): BOOTSTRAP_USERNAME, BOOTSTRAP_EMAIL,
//   BOOTSTRAP_DISPLAY_NAME, BOOTSTRAP_AREA and BOOTSTRAP_PASSWORD_FILE.
// The password is never accepted as a command-line argument or environment
// variable, so it does not end up in shell history or process listings.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { BootstrapError, bootstrapAdmin } from './lib/bootstrap.js';
import { inLockedTransaction, loadToolsConfig, withOwnerClient } from './lib/connection.js';

const emergency = process.argv.includes('--emergency');
const config = loadToolsConfig();

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    let value = '';
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelado'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function askInteractive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const input = {
    username: (await rl.question('Usuario: ')).trim(),
    email: (await rl.question('Email: ')).trim(),
    displayName: (await rl.question('Nombre completo: ')).trim(),
    areaName: (await rl.question('Área (se crea si no existe): ')).trim(),
  };
  rl.close();
  input.password = await readHidden('Contraseña (12 caracteres o más): ');
  const confirmation = await readHidden('Repita la contraseña: ');
  if (confirmation !== input.password) throw new BootstrapError(['Las contraseñas no coinciden.']);
  return input;
}

function readFromEnvironment() {
  const { BOOTSTRAP_USERNAME, BOOTSTRAP_EMAIL, BOOTSTRAP_DISPLAY_NAME, BOOTSTRAP_AREA, BOOTSTRAP_PASSWORD_FILE } = process.env;
  if (!BOOTSTRAP_PASSWORD_FILE) {
    throw new BootstrapError(['Sin terminal interactiva: defina BOOTSTRAP_USERNAME, BOOTSTRAP_EMAIL, '
      + 'BOOTSTRAP_DISPLAY_NAME, BOOTSTRAP_AREA y BOOTSTRAP_PASSWORD_FILE.']);
  }
  return {
    username: BOOTSTRAP_USERNAME?.trim(),
    email: BOOTSTRAP_EMAIL?.trim(),
    displayName: BOOTSTRAP_DISPLAY_NAME?.trim(),
    areaName: BOOTSTRAP_AREA?.trim(),
    password: readFileSync(BOOTSTRAP_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, ''),
  };
}

try {
  console.log(emergency ? 'Creación de la cuenta de emergencia' : 'Creación del superadmin inicial');
  const input = process.stdin.isTTY ? await askInteractive() : readFromEnvironment();
  const result = await withOwnerClient(config, (client) =>
    inLockedTransaction(client, 'enviotec.bootstrap', () =>
      bootstrapAdmin(client, input, { emergency, argon2: config.argon2 })));
  console.log(`Cuenta creada (${result.userId}). `
    + (emergency ? 'Exenta de vigencia.' : `Vence el ${result.expiresAt.toISOString()}.`)
    + ' El MFA se configura en el primer inicio de sesión.');
} catch (error) {
  if (error instanceof BootstrapError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
