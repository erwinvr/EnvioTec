// Browser check of the core frontend (phase 7 exit criterion): signs in as
// the bootstrap superadmin, enrolls MFA, walks every core screen, creates an
// area and a local user, switches language and signs out. Fails on any CSP
// or Trusted Types violation, console error or uncaught page error.
// Runs inside the official Playwright image from scripts/check.sh.
/* global document, window -- page.waitForFunction and addInitScript run these functions in the browser */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE_URL = process.env.BASE_URL;
const USERNAME = process.env.E2E_USERNAME;
const PASSWORD = readFileSync(process.env.E2E_PASSWORD_FILE, 'utf8').trim();
const problems = [];

function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function ready(page, hash) {
  await page.waitForFunction((expected) => {
    const main = document.getElementById('app');
    return main?.dataset.state === 'ready' && (!expected || window.location.hash.startsWith(expected));
  }, hash, { timeout: 15000 });
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    problems.push(`${name}: ${error.message.split('\n')[0]}`);
    console.log(`FAIL ${name}`);
    throw error;
  }
}

const browser = await chromium.launch({ chromiumSandbox: false });
const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'es-BO' });
const page = await context.newPage();
await page.exposeFunction('reportViolation', (text) => problems.push(`CSP: ${text}`));
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (event) => {
    window.reportViolation(`${event.violatedDirective} ${event.blockedURI}`);
  });
});
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()} @ ${message.location().url}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
// Expected 401 of GET /auth/me before signing in is not a console error
// worth failing on; Chromium logs failed requests as errors, so they are
// filtered below by URL.
const expectedStatus = (text) => /\/api\/v1\/auth\/me\b/.test(text) && /status of 401/.test(text);

try {
  await step('sin sesión lleva al login', async () => {
    await page.goto(`${BASE_URL}/`);
    await ready(page, '#/ingresar');
  });

  await step('login del superadmin', async () => {
    await page.fill('#field-username', USERNAME);
    await page.fill('#field-password', PASSWORD);
    await page.click('form button[type="submit"]');
    await ready(page, '#/mfa/configurar');
  });

  await step('enrolamiento de MFA con QR y códigos de recuperación', async () => {
    const secret = await page.textContent('[data-testid="totp-secret"]');
    const qrSrc = await page.getAttribute('img.qr', 'src');
    if (!qrSrc?.startsWith('data:image/svg+xml;base64,')) throw new Error('falta el QR');
    await page.fill('#field-code', totp(secret.trim()));
    await page.click('form button[type="submit"]');
    await page.waitForSelector('.secret-values code');
    const codes = await page.locator('.secret-values code').count();
    if (codes !== 10) throw new Error(`se esperaban 10 códigos, hay ${codes}`);
    await page.click('button.button-primary');
    await ready(page, '#/');
  });

  for (const [hash, selector] of [
    ['#/usuarios', 'table'], ['#/usuarios/revision', 'table'], ['#/roles', 'table'], ['#/areas', 'table'],
    ['#/directorio', '.data-table'], ['#/parametros', 'table'], ['#/auditoria', 'table'], ['#/mi-cuenta', 'table'],
  ]) {
    await step(`pantalla ${hash}`, async () => {
      await page.goto(`${BASE_URL}/${hash}`);
      await ready(page, hash);
      await page.waitForSelector(`main ${selector}`, { timeout: 10000 });
    });
  }

  const areaName = `E2E Área ${Date.now()}`;
  await step('alta de un área desde un modal', async () => {
    await page.goto(`${BASE_URL}/#/areas`);
    await ready(page, '#/areas');
    await page.click('.page-header button.button-primary');
    await page.fill('dialog #field-name', areaName);
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector(`td:text-is("${areaName}")`);
  });

  await step('alta de una cuenta local con contraseña temporal', async () => {
    await page.goto(`${BASE_URL}/#/usuarios/nuevo`);
    await ready(page, '#/usuarios/nuevo');
    const suffix = Date.now().toString(36);
    await page.fill('#field-username', `e2e.${suffix}`);
    await page.fill('#field-email', `e2e.${suffix}@empresa.test`);
    await page.fill('#field-displayName', 'Usuario E2E');
    await page.selectOption('#field-areaId', { label: areaName });
    await page.click('form button[type="submit"]');
    await page.waitForSelector('.secret-values code');
    const password = (await page.textContent('.secret-values code')).trim();
    if (password.length !== 20) throw new Error('contraseña temporal inesperada');
    await page.click('.secret-box ~ .actions button');
    await ready(page, '#/usuarios/');
    await page.waitForSelector('.permission-list, .details');
  });

  await step('cambio de idioma', async () => {
    await page.selectOption('select.language', 'en');
    await page.waitForSelector('nav a:text-is("Users")');
    await page.selectOption('select.language', 'es');
    await page.waitForSelector('nav a:text-is("Usuarios")');
  });

  await step('cierre de sesión', async () => {
    await page.click('.session button');
    await ready(page, '#/ingresar');
  });
} catch {
  // The failing step is already recorded.
} finally {
  await browser.close();
}

const real = problems.filter((problem) => !(problem.startsWith('console:') && expectedStatus(problem)));
if (real.length > 0) {
  console.error('\nProblemas encontrados en el navegador:');
  for (const problem of real) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nNavegador: sin violaciones de CSP ni errores en consola.');
