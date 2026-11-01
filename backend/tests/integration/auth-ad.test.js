// AD login flows (ADR-006) against the real PostgreSQL and Redis, with a
// simulated directory behind the LDAP client (ADR-019): JIT provisioning,
// area and roles from AD, group and state checks, lockout before AD's own
// limit, collisions, renames and a single authentication origin.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createHarness, PASSWORD } from '../helpers/auth-fixtures.js';
import { AD_ENV, ALLOWED, createDirectory, OPERATORS } from '../helpers/fake-directory.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe('autenticación con AD (directorio simulado)', { skip: !enabled && 'requiere RUN_INTEGRATION=1 (scripts/check.sh)' }, () => {
  let h;
  let dir;
  let operatorRole;
  const name = (suffix) => `${h.prefix}.${suffix}`;
  const userRow = async (username) => (await h.owner.query(
    `SELECT u.id, u.auth_source, u.area_id, u.ad_object_guid, u.username,
            array(SELECT role_id::text FROM user_roles WHERE user_id = u.id AND source = 'ad_group') AS ad_roles
       FROM users u WHERE u.username = $1`,
    [username],
  )).rows[0];

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

  it('primer login: crea la cuenta (JIT) por objectGUID, con área por department y rol por grupo', async () => {
    dir.add(name('ana'), { department: `${h.prefix}-DEP`, groups: [ALLOWED, OPERATORS] });
    const { res } = await h.login(name('ana'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.stage, 'full');
    assert.deepEqual(res.json().data.permissions, ['campaigns.view']);
    const row = await userRow(name('ana'));
    assert.equal(row.auth_source, 'ad');
    assert.equal(row.area_id, h.areaId, 'department sin distinguir mayúsculas');
    assert.deepEqual(row.ad_roles, [operatorRole]);
    const created = await h.audits('user.create', row.id);
    assert.equal(created[0].metadata.source, 'ad_jit');

    assert.equal((await h.login(name('ana'))).res.statusCode, 200);
    const { rows } = await h.owner.query('SELECT count(*)::int AS n FROM users WHERE ad_object_guid = $1', [row.ad_object_guid]);
    assert.equal(rows[0].n, 1, 'el segundo login no duplica la cuenta');
  });

  it('el rol de AD se retira cuando el usuario sale del grupo mapeado', async () => {
    const user = dir.add(name('roles'), { groups: [ALLOWED, OPERATORS] });
    await h.login(name('roles'));
    user.groups = [ALLOWED];
    const { res } = await h.login(name('roles'));
    assert.deepEqual(res.json().data.permissions, []);
    assert.deepEqual((await userRow(name('roles'))).ad_roles, []);
  });

  it('sin department coincidente entra sin área; fuera del grupo habilitado no entra', async () => {
    dir.add(name('nodept'), { department: 'Otra' });
    assert.equal((await h.login(name('nodept'))).res.statusCode, 200);
    assert.equal((await userRow(name('nodept'))).area_id, null);

    dir.add(name('outside'), { groups: [] });
    const { res } = await h.login(name('outside'));
    assert.equal(res.statusCode, 401);
    assert.equal(await userRow(name('outside')), undefined, 'no se crea la cuenta');
  });

  it('cuenta deshabilitada en AD: pierde el acceso y se revocan sus sesiones', async () => {
    const user = dir.add(name('disable'));
    const first = await h.login(name('disable'));
    user.disabled = true;
    const { res } = await h.login(name('disable'));
    assert.equal(res.statusCode, 401);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token: first.token })).statusCode, 401);
    const row = await userRow(name('disable'));
    assert.equal((await h.audits('auth.login', row.id)).at(-1).metadata.reason, 'ad_account_disabled');
  });

  it('la re-autenticación vuelve a consultar AD', async () => {
    const user = dir.add(name('reauth'));
    const { token } = await h.login(name('reauth'));
    user.groups = [];
    const res = await h.request('POST', '/api/v1/auth/reauth', { token, payload: { password: PASSWORD } });
    assert.equal(res.statusCode, 401);
    assert.equal((await h.request('GET', '/api/v1/auth/me', { token })).statusCode, 401);
  });

  it('bloqueo: EnvioTec corta a los 2 fallos y AD nunca llega a su límite de 3', async () => {
    const user = dir.add(name('lock'));
    await h.login(name('lock'));
    for (let i = 0; i < 2; i += 1) assert.equal((await h.login(name('lock'), 'mala')).res.statusCode, 401);
    const binds = dir.state.userBinds;
    const blocked = await h.login(name('lock'));
    assert.equal(blocked.res.statusCode, 401);
    assert.equal(dir.state.userBinds, binds, 'con la cuenta bloqueada no se consulta AD');
    assert.equal(user.badPwdCount, 2);
    const { rows } = await h.owner.query("SELECT locked_until > now() + interval '14 minutes' AS locked FROM users WHERE username = $1", [name('lock')]);
    assert.equal(rows[0].locked, true, 'bloqueo de 15 minutos');
  });

  it('bloqueo también para cuentas que todavía no existen en EnvioTec', async () => {
    const user = dir.add(name('lock-new'));
    for (let i = 0; i < 2; i += 1) await h.login(name('lock-new'), 'mala');
    const binds = dir.state.userBinds;
    assert.equal((await h.login(name('lock-new'))).res.statusCode, 401);
    assert.equal(dir.state.userBinds, binds);
    assert.equal(user.badPwdCount, 2);
  });

  it('colisión: un email de AD que ya usa una cuenta local se rechaza y se audita, sin fusionar', async () => {
    const local = await h.localUser('colision');
    dir.add(name('colision-ad'), { mail: local.email });
    const { res } = await h.login(name('colision-ad'));
    assert.equal(res.statusCode, 401);
    assert.equal(await userRow(name('colision-ad')), undefined);
    const { rows } = await h.owner.query(
      "SELECT 1 FROM audit_logs WHERE action = 'auth.ad_collision' AND metadata->>'username' = $1", [name('colision-ad')],
    );
    assert.equal(rows.length, 1);
  });

  it('origen único: una cuenta local con el mismo usuario que en AD nunca se autentica contra AD', async () => {
    const local = await h.localUser('mismo-nombre');
    const twin = dir.add(local.username);
    twin.password = 'clave-de-ad-distinta';
    const binds = dir.state.userBinds;
    assert.equal((await h.login(local.username, 'clave-de-ad-distinta')).res.statusCode, 401);
    assert.equal(dir.state.userBinds, binds);
    assert.equal((await h.login(local.username)).res.statusCode, 200);
  });

  it('renombrada en AD: se reconoce por objectGUID y se actualiza el usuario', async () => {
    dir.add(name('viejo'));
    await h.login(name('viejo'));
    const { id } = await userRow(name('viejo'));
    dir.rename(name('viejo'), name('nuevo'));
    assert.equal((await h.login(name('nuevo'))).res.statusCode, 200);
    assert.equal((await userRow(name('nuevo'))).id, id);
  });

  it('mismo nombre pero otro objectGUID: no es la misma persona', async () => {
    const user = dir.add(name('guid'));
    await h.login(name('guid'));
    user.guid = randomBytes(16);
    const { res } = await h.login(name('guid'));
    assert.equal(res.statusCode, 401);
  });

  it('AD caído: 503 y el intento no cuenta como fallo', async () => {
    dir.add(name('caido'));
    await h.login(name('caido'));
    dir.state.down = true;
    try {
      const { res } = await h.login(name('caido'));
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error.code, 'SERVICE_UNAVAILABLE');
    } finally {
      dir.state.down = false;
    }
    const { rows } = await h.owner.query('SELECT failed_login_count FROM users WHERE username = $1', [name('caido')]);
    assert.equal(rows[0].failed_login_count, 0);
  });
});
