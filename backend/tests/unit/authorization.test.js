import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateSessionToken, hashToken, isWellFormedToken, readCookie } from '../../src/core/auth/session-token.js';
import { areaCondition, areaScopeFor, findForWrite, writeScopeFor } from '../../src/core/authorization/area-scope.js';
import { AreaWriteDeniedError, AuthorizationError, NotFoundError } from '../../src/core/errors/errors.js';
import { PERMISSION_CATALOG, PERMISSION_CODES } from '../../src/modules/permission-catalog.js';

describe('tokens de sesión', () => {
  it('genera tokens de 256 bits en base64url y guarda solo su hash', () => {
    const token = generateSessionToken();
    assert.ok(isWellFormedToken(token));
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.notEqual(generateSessionToken(), token);
    assert.equal(hashToken(token).length, 32);
    assert.ok(!hashToken(token).toString('hex').includes(Buffer.from(token, 'base64url').toString('hex')));
  });

  it('rechaza tokens mal formados', () => {
    for (const value of [null, '', 'corto', 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}.`]) {
      assert.equal(isWellFormedToken(value), false);
    }
  });

  it('lee una cookie por nombre exacto', () => {
    assert.equal(readCookie('a=1; __Host-enviotec_session=abc; b=2', '__Host-enviotec_session'), 'abc');
    assert.equal(readCookie('x__Host-enviotec_session=abc', '__Host-enviotec_session'), null);
    assert.equal(readCookie(undefined, 'a'), null);
    assert.equal(readCookie(`a=${'x'.repeat(9000)}`, 'a'), null);
  });
});

describe('alcance por área (ADR-008)', () => {
  const auth = (areaId, codes = []) => ({ user: { areaId }, permissions: new Set(codes) });

  it('areas.view_all ve todas las áreas; el resto solo la suya; sin área no ve nada', () => {
    assert.deepEqual(areaScopeFor(auth('a1', ['areas.view_all'])), { all: true });
    assert.deepEqual(areaScopeFor(auth('a1')), { all: false, areaId: 'a1' });
    assert.equal(areaScopeFor(auth(null)), null);
    assert.equal(areaScopeFor(null), null);
  });

  it('areas.view_all amplía la lectura, nunca la escritura (ADR-026)', async () => {
    assert.deepEqual(writeScopeFor(auth('a1', ['areas.view_all'])), { all: false, areaId: 'a1' });
    assert.equal(writeScopeFor(auth(null, ['areas.view_all'])), null);
    const rows = { a1: { id: 'r1', area_id: 'a1' }, a2: { id: 'r2', area_id: 'a2' } };
    // A fake repository lookup: the row of `area` if the scope covers it.
    const finder = (area) => async (scope) => (scope.all || scope.areaId === area ? rows[area] : null);
    assert.equal(await findForWrite(auth('a1'), { resourceType: 'template', id: 'r1', find: finder('a1') }), rows.a1);
    await assert.rejects(findForWrite(auth('a1', ['areas.view_all']), { resourceType: 'template', id: 'r2', find: finder('a2') }),
      (error) => error instanceof AreaWriteDeniedError && error.statusCode === 403 && error.resourceId === 'r2');
    await assert.rejects(findForWrite(auth('a1'), { resourceType: 'template', id: 'r2', find: finder('a2') }), NotFoundError);
  });

  it('genera una condición parametrizada', () => {
    const params = ['x'];
    assert.equal(areaCondition({ all: false, areaId: 'a1' }, 'c.area_id', params), 'c.area_id = $2');
    assert.deepEqual(params, ['x', 'a1']);
    assert.equal(areaCondition({ all: true }, 'area_id', []), 'TRUE');
  });

  it('niega el acceso sin alcance y rechaza nombres de columna inseguros', () => {
    assert.throws(() => areaCondition(null, 'area_id', []), AuthorizationError);
    assert.throws(() => areaCondition({ all: false, areaId: '' }, 'area_id', []), AuthorizationError);
    assert.throws(() => areaCondition({ all: true }, 'area_id; DROP TABLE users', []), /invalid column/);
    assert.throws(() => areaCondition({ all: true }, 'Area_Id', []), /invalid column/);
  });
});

describe('catálogo de permisos', () => {
  it('tiene códigos únicos con formato <recurso>.<acción>', () => {
    assert.equal(PERMISSION_CODES.size, PERMISSION_CATALOG.length);
    for (const permission of PERMISSION_CATALOG) {
      assert.match(permission.code, /^[a-z][a-z_]*\.[a-z][a-z_]*$/);
      assert.ok(permission.description.length > 0);
      assert.equal(typeof permission.administrative, 'boolean');
    }
  });

  it('marca como administrativos exactamente los permisos definidos en la arquitectura', () => {
    const administrative = PERMISSION_CATALOG.filter((p) => p.administrative).map((p) => p.code).sort();
    assert.deepEqual(administrative, [
      'areas.manage', 'directory.manage', 'quotas.manage', 'roles.assign', 'roles.create', 'roles.delete',
      'roles.update', 'senders.manage', 'sessions.revoke_any', 'settings.manage', 'suppressions.manage',
      'users.create_local', 'users.disable', 'users.renew_local', 'users.reset_mfa', 'users.reset_password',
      'users.unlock', 'users.update',
    ]);
  });

  it('no incluye users.create (las cuentas de AD se crean por JIT)', () => {
    assert.equal(PERMISSION_CODES.has('users.create'), false);
  });
});
