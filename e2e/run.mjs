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

  const suffix = Date.now().toString(36);
  await step('alta de una cuenta local con contraseña temporal', async () => {
    await page.goto(`${BASE_URL}/#/usuarios/nuevo`);
    await ready(page, '#/usuarios/nuevo');
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

  await step('parámetro de dominios de envío y alta de un remitente', async () => {
    await page.goto(`${BASE_URL}/#/parametros`);
    await ready(page, '#/parametros');
    await page.click('tr:has(code:text-is("sending.sender_domains")) button');
    await page.fill('dialog #field-value', 'envios.e2e.test');
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector('tr:has(code:text-is("sending.sender_domains")) td:text-is("envios.e2e.test")');
    await page.goto(`${BASE_URL}/#/remitentes`);
    await ready(page, '#/remitentes');
    await page.click('.page-header button.button-primary');
    await page.selectOption('dialog #field-areaId', { label: areaName });
    await page.fill('dialog #field-email', `ventas.${suffix}@envios.e2e.test`);
    await page.fill('dialog #field-displayName', 'Ventas E2E');
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector(`code:text-is("ventas.${suffix}@envios.e2e.test")`);
  });

  await step('ajuste de cuota con motivo y saldo propio', async () => {
    await page.goto(`${BASE_URL}/#/cuotas`);
    await ready(page, '#/cuotas');
    await page.fill('.filters input[name="search"]', `e2e.${suffix}`);
    await page.click('.filters button[type="submit"]');
    await page.click(`tr:has(td:text-is("e2e.${suffix}")) button:text-is("Ajustar")`);
    await page.fill('dialog #field-delta', '250');
    await page.fill('dialog #field-reason', 'Asignación de prueba del recorrido E2E');
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector(`tr:has(td:text-is("e2e.${suffix}")) td:text-is("250")`);
    await page.goto(`${BASE_URL}/#/mis-envios`);
    await ready(page, '#/mis-envios');
    await page.waitForSelector('main .details');
  });

  await step('lista de contactos e importación CSV revisada por antivirus', async () => {
    await page.goto(`${BASE_URL}/#/contactos`);
    await ready(page, '#/contactos');
    await page.click('.page-header button.button-primary');
    await page.fill('dialog #field-name', `Clientes ${suffix}`);
    await page.fill('dialog #field-attributes', 'ciudad, plan');
    await page.selectOption('dialog #field-areaId', { label: areaName });
    await page.click('dialog form button[type="submit"]');
    await ready(page, '#/contactos/');
    const csv = 'email;first_name;ciudad\nana@e2e.test;Ana;La Paz\nmalo;X;Y\nluis@e2e.test;Luis;Sucre\n';
    await page.setInputFiles('input[type="file"]', { name: 'clientes.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.click('button:text-is("Importar")');
    await page.waitForSelector('td:text-is("2 nuevos, 0 actualizados, 1 rechazados")', { timeout: 60000 });
    await page.waitForSelector('td:text-is("ana@e2e.test"), span:text-is("ana@e2e.test")');
  });

  await step('supresión manual', async () => {
    await page.goto(`${BASE_URL}/#/supresion`);
    await ready(page, '#/supresion');
    await page.click('.page-header button:text-is("Suprimir email")');
    await page.fill('dialog #field-email', `baja.${suffix}@e2e.test`);
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector(`td:text-is("baja.${suffix}@e2e.test")`);
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
