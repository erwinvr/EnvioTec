// Worker jobs of phase 5 (Parte B) against the real PostgreSQL: daily control
// of local accounts and the 15-minute review of AD accounts (simulated
// directory, ADR-019). Also the scheduler's exclusivity between replicas.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import { createAuditService } from '../../src/core/audit/audit.service.js';
import { createAdProvider } from '../../src/core/auth/providers/ad.provider.js';
import { runExclusive } from '../../src/core/jobs/scheduler.js';
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createAccountValidityJob } from '../../src/modules/users/jobs/account-validity.job.js';
import { createAdReviewJob } from '../../src/modules/users/jobs/ad-review.job.js';
import { createJobsRepository } from '../../src/modules/users/jobs/jobs.repository.js';
import { createHarness } from '../helpers/auth-fixtures.js';
import { AD_ENV, ALLOWED, createDirectory, OPERATORS } from '../helpers/fake-directory.js';

const enabled = process.env.RUN_INTEGRATION === '1';
const logger = pino({ level: 'silent' });

describe('trabajos del worker: cuentas locales y revisión de AD', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let dir;
  let operatorRole;
  const mailer = { enabled: true, sent: [], async send(message) { this.sent.push(message); } };
  const status = async (id) => (await h.owner.query('SELECT status, disabled_reason FROM users WHERE id = $1', [id])).rows[0];
  const validityJob = () => createAccountValidityJob({
    pool: h.pool, repository: createJobsRepository(), audit: createAuditService(), mailer, logger,
  });
  const adJob = () => createAdReviewJob({
    pool: h.pool, repository: createJobsRepository(), authRepository: createAuthRepository(),
    ad: createAdProvider(h.config.ad, { clientFactory: dir.factory, logger }), audit: createAuditService(), logger,
  });

  before(async () => {
    dir = createDirectory();
    h = await createHarness({ env: AD_ENV, adClientFactory: dir.factory });
    operatorRole = await h.role('operador', ['campaigns.view']);
    await h.owner.query('INSERT INTO ad_group_role_mappings (group_dn, role_id) VALUES ($1, $2) ON CONFLICT (group_dn) DO UPDATE SET role_id = $2',
      [OPERATORS, operatorRole]);
  });
  after(async () => {
    await h?.owner.query('DELETE FROM ad_group_role_mappings WHERE group_dn = $1', [OPERATORS]);
    await h?.close();
  });

  it('vigencia: desactiva vencidas e inactivas, revoca sesiones y respeta renovadas y la cuenta de emergencia', async () => {
    const expired = await h.localUser('vencida');
    const session = await h.login(expired.username);
    await h.owner.query("UPDATE users SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    const inactive = await h.localUser('inactiva');
    await h.owner.query("UPDATE users SET created_at = now() - interval '60 days', last_login_at = now() - interval '50 days' WHERE id = $1", [inactive.id]);
    const renewed = await h.localUser('renovada');
    await h.owner.query("UPDATE users SET created_at = now() - interval '60 days', last_login_at = now() - interval '50 days', activity_reset_at = now() WHERE id = $1", [renewed.id]);
    const emergency = await h.localUser('emergencia');
    await h.owner.query(
      "UPDATE users SET is_emergency = true, exempt_from_expiry = true, expires_at = NULL, created_at = now() - interval '200 days' WHERE id = $1",
      [emergency.id],
    );

    const result = await validityJob()();
    assert.ok(result.expired >= 1 && result.inactive >= 1);
    assert.deepEqual(await status(expired.id), { status: 'disabled', disabled_reason: 'expired' });
    assert.deepEqual(await status(inactive.id), { status: 'disabled', disabled_reason: 'inactive' });
    assert.equal((await status(renewed.id)).status, 'active');
    assert.equal((await status(emergency.id)).status, 'active');
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: session.token })).statusCode, 401);
    assert.equal((await h.audits('user.disable', expired.id))[0].metadata.reason, 'expired');
  });

  it('vigencia: avisa una sola vez a la cuenta y a los administradores antes del vencimiento', async () => {
    const soon = await h.localUser('por-vencer', { expiresInMinutes: 3 * 24 * 60 });
    const { rows: setting } = await h.owner.query("SELECT value FROM system_settings WHERE key = 'notifications.admin_emails'");
    await h.owner.query("UPDATE system_settings SET value = '[\"ti@empresa.test\"]' WHERE key = 'notifications.admin_emails'");
    try {
      mailer.sent.length = 0;
      await validityJob()();
      const mine = mailer.sent.filter((m) => m.text.includes(soon.username));
      assert.deepEqual(mine.map((m) => m.to).sort(), [soon.email, 'ti@empresa.test'].sort());
      mailer.sent.length = 0;
      await validityJob()();
      assert.equal(mailer.sent.filter((m) => m.text.includes(soon.username)).length, 0, 'no repite el aviso');
      assert.equal((await h.audits('user.expiry_warning', soon.id)).length, 1);
    } finally {
      await h.owner.query("UPDATE system_settings SET value = $1 WHERE key = 'notifications.admin_emails'", [JSON.stringify(setting[0].value)]);
    }
  });

  it('revisión de AD: cuenta deshabilitada en AD pierde sus sesiones (auditado una vez)', async () => {
    const user = dir.add(`${h.prefix}.ad-baja`);
    const { token } = await h.login(user.username);
    user.disabled = true;
    const summary = await adJob()();
    assert.ok(summary.revoked >= 1);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token })).statusCode, 401);
    const { rows } = await h.owner.query('SELECT id FROM users WHERE username = $1', [user.username]);
    await adJob()();
    const events = await h.audits('user.ad_review', rows[0].id);
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.reason, 'ad_account_disabled');
  });

  it('revisión de AD: cuenta que ya no existe o salió del grupo habilitado', async () => {
    const gone = dir.add(`${h.prefix}.ad-borrada`);
    const goneSession = await h.login(gone.username);
    dir.rename(gone.username, `${h.prefix}.otra-persona`);
    const outside = dir.add(`${h.prefix}.ad-fuera`);
    const outsideSession = await h.login(outside.username);
    outside.groups = [];
    await adJob()();
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: goneSession.token })).statusCode, 401);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: outsideSession.token })).statusCode, 401);
  });

  it('revisión de AD: los roles siguen a los grupos y un cambio revoca las sesiones', async () => {
    const user = dir.add(`${h.prefix}.ad-roles`, { groups: [ALLOWED, OPERATORS] });
    const { res, token } = await h.login(user.username);
    assert.deepEqual(res.json().data.permissions, ['campaigns.view']);
    user.groups = [ALLOWED];
    await adJob()();
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token })).statusCode, 401);
    const again = await h.login(user.username);
    assert.deepEqual(again.res.json().data.permissions, []);
  });

  it('revisión de AD: con AD caído la ronda falla sin revocar nada, y se reintenta en la siguiente', async () => {
    const user = dir.add(`${h.prefix}.ad-caido`);
    const { token } = await h.login(user.username);
    dir.state.down = true;
    try {
      await assert.rejects(adJob()(), (error) => error.code === 'SERVICE_UNAVAILABLE');
    } finally {
      dir.state.down = false;
    }
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token })).statusCode, 200);
  });

  it('el programador ejecuta cada trabajo en una sola réplica a la vez', async () => {
    let release;
    const first = runExclusive(h.pool, 'test-exclusivo', () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await runExclusive(h.pool, 'test-exclusivo', async () => 'segunda'), { skipped: true });
    release('primera');
    assert.equal(await first, 'primera');
    assert.equal(await runExclusive(h.pool, 'test-exclusivo', async () => 'tercera'), 'tercera');
  });
});
