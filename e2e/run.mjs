// Browser check of the core frontend (phase 7 exit criterion): signs in as
// the bootstrap superadmin, enrolls MFA, walks every core screen, creates an
// area and a local user, switches language and signs out. Fails on any CSP
// or Trusted Types violation, console error or uncaught page error.
// Runs inside the official Playwright image from scripts/check.sh.
/* global document, window -- page.waitForFunction and addInitScript run these functions in the browser */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { docx, PNG } from '../backend/tests/helpers/docx.js';
import { pdf } from '../backend/tests/helpers/pdf.js';

const BASE_URL = process.env.BASE_URL;
// Area of the bootstrap superadmin (scripts/check.sh, BOOTSTRAP_AREA).
const OWN_AREA = 'Administración E2E';
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
    problems.push(`${name}: ${error.message.split('\n').slice(0, 3).join(' | ')}`);
    console.log(`FAIL ${name}`);
    // What the user would have seen, to diagnose the failure.
    const seen = await page.evaluate(() => ({
      hash: window.location.hash,
      main: document.getElementById('app')?.innerText.slice(0, 600),
      toasts: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent),
      dialog: document.querySelector('dialog')?.innerText.slice(0, 400) ?? null,
    })).catch(() => null);
    console.log(JSON.stringify(seen));
    console.log(JSON.stringify({ pendingRequests: [...pending.values()], lastApiResponses: apiLog.slice(-8) }));
    throw error;
  }
}

const browser = await chromium.launch({ chromiumSandbox: false });
const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'es-BO' });
const page = await context.newPage();
// Network trace for failure diagnostics: requests still open and the last API answers.
const pending = new Map();
const apiLog = [];
page.on('request', (request) => pending.set(request, `${request.method()} ${new URL(request.url()).pathname}`));
page.on('requestfailed', (request) => pending.delete(request));
page.on('requestfinished', async (request) => {
  const label = pending.get(request);
  pending.delete(request);
  if (label?.includes(' /api/')) apiLog.push(`${label} -> ${(await request.response())?.status()}`);
});
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
    // The superadmin's own area: business data is created only there (ADR-026).
    await page.selectOption('dialog #field-areaId', { label: OWN_AREA });
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

  await step('lista con variables e importación CSV con asociación de columnas (antivirus)', async () => {
    await page.goto(`${BASE_URL}/#/contactos`);
    await ready(page, '#/contactos');
    await page.click('.page-header button.button-primary');
    await page.fill('dialog #field-name', `Clientes ${suffix}`);
    await page.click('dialog form button[type="submit"]');
    await ready(page, '#/contactos/');
    // Variables first (ADR-028): "Ciudad" becomes {{ciudad}}.
    await page.click('button:text-is("Nueva variable")');
    await page.fill('dialog #field-label', 'Ciudad');
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector('code:text-is("{{ciudad}}")');
    // Headers in Spanish: the mapping is suggested and confirmed.
    const csv = 'Correo;Nombre;Ciudad;Notas\nana@e2e.test;Ana;La Paz;x\nmalo;X;Y;x\nluis@e2e.test;Luis;Sucre;x\n';
    await page.setInputFiles('input[type="file"]', { name: 'clientes.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.click('button:text-is("Importar")');
    await page.waitForSelector('dialog #field-col_0', { timeout: 60000 });
    if (await page.inputValue('dialog #field-col_2') !== 'ciudad') throw new Error('la columna Ciudad no se sugirió como {{ciudad}}');
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector('td:text-is("2 nuevos, 0 actualizados, 1 rechazados")', { timeout: 60000 });
    await page.waitForSelector('td:text-is("ana@e2e.test"), span:text-is("ana@e2e.test")');
  });

  await step('plantilla .docx convertida y vista previa aislada', async () => {
    await page.goto(`${BASE_URL}/#/plantillas`);
    await ready(page, '#/plantillas');
    await page.click('.page-header button.button-primary');
    await page.fill('dialog #field-name', `Bienvenida ${suffix}`);
    await page.click('dialog form button[type="submit"]');
    await ready(page, '#/plantillas/');
    const file = docx({ paragraphs: ['Hola {{first_name}}', 'Su ciudad: {{ciudad}}'], png: PNG });
    await page.setInputFiles('input[type="file"]', { name: 'bienvenida.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file });
    await page.click('button:text-is("Subir .docx")');
    await page.waitForSelector('span.badge:text-is("Lista")', { timeout: 60000 });
    await page.click('button:text-is("Vista previa")');
    const frame = await (await page.waitForSelector('iframe.preview')).contentFrame();
    await frame.waitForSelector('text=Hola {{first_name}}');
    await page.click('dialog .modal-close');
  });

  await step('campaña con PDF inspeccionado y envío a aprobación (maker-checker)', async () => {
    await page.goto(`${BASE_URL}/#/campanias`);
    await ready(page, '#/campanias');
    await page.click('.page-header button.button-primary');
    await page.waitForSelector('dialog #field-templateId option:nth-child(2)', { state: 'attached' });
    await page.fill('dialog #field-name', `Lanzamiento ${suffix}`);
    await page.fill('dialog #field-subject', 'Novedades de EnvioTec');
    await page.selectOption('dialog #field-templateId', { label: `Bienvenida ${suffix} (v1)` });
    await page.selectOption('dialog #field-listId', { label: `Clientes ${suffix} (2)` });
    await page.selectOption('dialog #field-senderId', { label: `Ventas E2E <ventas.${suffix}@envios.e2e.test>` });
    await page.click('dialog form button[type="submit"]');
    await ready(page, '#/campanias/');
    await page.setInputFiles('input[type="file"]', { name: 'folleto.pdf', mimeType: 'application/pdf', buffer: pdf() });
    await page.click('button:text-is("Subir PDF")');
    await page.waitForSelector('dd span:has-text("folleto.pdf") .badge:text-is("Lista")', { timeout: 60000 });
    await page.click('.page-header button:text-is("Enviar a aprobación")');
    await page.waitForSelector('.badge:text-is("En aprobación")');
    if (await page.locator('.page-header button:text-is("Aprobar")').count() !== 0) throw new Error('quien envía no debe ver Aprobar');
  });

  await step('supresión manual', async () => {
    await page.goto(`${BASE_URL}/#/supresion`);
    await ready(page, '#/supresion');
    await page.click('.page-header button:text-is("Suprimir email")');
    await page.fill('dialog #field-email', `baja.${suffix}@e2e.test`);
    await page.click('dialog form button[type="submit"]');
    await page.waitForSelector(`td:text-is("baja.${suffix}@e2e.test")`);
  });

  await step('reportes por campaña y búsqueda por contacto', async () => {
    await page.goto(`${BASE_URL}/#/reportes`);
    await ready(page, '#/reportes');
    await page.waitForSelector('.table-body .empty, .table-body table');
    await page.click('.page-header button:text-is("Buscar por contacto")');
    await ready(page, '#/reportes/contacto');
    await page.fill('#field-email', `baja.${suffix}@e2e.test`);
    await page.click('main form button[type="submit"]');
    await page.waitForSelector('main section .table-body .empty, main section .table-body table');
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
