import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionOptions, isDatabaseUrl, parseDatabaseUrl } from '../../src/core/db/connection-url.js';
import { normalizeError } from '../../src/core/db/errors.js';
import { toTsql } from '../../src/core/db/pool.js';
import { escapeLike, inJson, jsonStrings, page, returning } from '../../src/core/db/sql.js';

describe('adaptador de SQL Server (ADR-032)', () => {
  it('los parámetros siguen siendo parámetros: $n pasa a @pn sin tocar el resto', () => {
    assert.equal(toTsql('SELECT * FROM t WHERE a = $1 AND b IN (SELECT value FROM OPENJSON($12))'),
      'SELECT * FROM t WHERE a = @p1 AND b IN (SELECT value FROM OPENJSON(@p12))');
    assert.equal(toTsql("SELECT JSON_VALUE(x, '$.name')"), "SELECT JSON_VALUE(x, '$.name')");
  });

  it('traduce los errores de SQL Server a los códigos SQLSTATE que la API ya entiende', () => {
    const cases = [
      [{ number: 2627, message: 'Violation of UNIQUE KEY constraint' }, '23505'],
      [{ number: 2601, message: 'Cannot insert duplicate key row' }, '23505'],
      [{ number: 547, message: 'The INSERT statement conflicted with the FOREIGN KEY constraint' }, '23503'],
      [{ number: 547, message: 'The INSERT statement conflicted with the CHECK constraint "x"' }, '23514'],
      [{ number: 229, message: 'The SELECT permission was denied' }, '42501'],
      [{ number: 51000, message: 'system roles cannot be deleted' }, '23514'],
      [{ number: 51001, message: 'audit_logs is append-only' }, '42501'],
      [{ number: 1205, message: 'deadlock' }, '40P01'],
      [{ code: 'ETIMEOUT', message: 'Timeout' }, '57014'],
    ];
    for (const [error, code] of cases) {
      const normalized = normalizeError(Object.assign(new Error(error.message), error));
      assert.equal(normalized.code, code, error.message);
      assert.equal(normalized.severity, 'ERROR');
    }
    const unknown = normalizeError(Object.assign(new Error('otro'), { number: 99999 }));
    assert.equal(unknown.severity, undefined, 'un error desconocido no se presenta como error del cliente');
  });

  it('incluye la causa que SQL Server informa antes del resumen genérico', () => {
    const error = Object.assign(new Error('Could not create constraint or index. See previous errors.'), {
      number: 1750, precedingErrors: [{ message: 'Column CHECK constraint references another column' }],
    });
    assert.match(normalizeError(error).message, /^Column CHECK constraint references another column \| Could not create/);
  });

  it('la URL de conexión tiene una forma estricta y TLS siempre activo', () => {
    assert.equal(isDatabaseUrl('sqlserver://enviotec_runtime:Clave%40123@sql.empresa.local:1433/enviotec'), true);
    for (const bad of ['postgres://u:p@h/db', 'sqlserver://u@h/db', 'sqlserver://u:p@h/db;x', 'sqlserver://u:p@h/1db', '']) {
      assert.equal(isDatabaseUrl(bad), false, bad);
    }
    assert.deepEqual(parseDatabaseUrl('sqlserver://enviotec_runtime:Clave%40123@sql.empresa.local:14330/enviotec'), {
      user: 'enviotec_runtime', password: 'Clave@123', server: 'sql.empresa.local', port: 14330, database: 'enviotec',
    });
    const options = connectionOptions({ url: 'sqlserver://u:p@10.0.0.5/enviotec', caCert: 'PEM', serverName: 'sql.empresa.local' }, 'app');
    assert.deepEqual([options.port, options.options.encrypt, options.options.trustServerCertificate, options.options.serverName],
      [1433, true, false, 'sql.empresa.local']);
    assert.equal(options.options.cryptoCredentialsDetails.ca, 'PEM');
  });

  it('helpers de SQL: LIKE literal, OUTPUT por tabla variable, JSON y paginación', () => {
    assert.equal(escapeLike('50%_[a]\\'), '50\\%\\_\\[a]\\\\');
    const out = returning({ id: 'uniqueidentifier', status: 'varchar(10)' }, { source: 'deleted' });
    assert.equal(out.declare, 'DECLARE @out TABLE (id uniqueidentifier, status varchar(10));');
    assert.equal(out.output, 'OUTPUT deleted.id, deleted.status INTO @out');
    assert.equal(out.select, 'SELECT id, status FROM @out;');
    assert.match(jsonStrings('p.code'), /STRING_ESCAPE\(p\.code, 'json'\).*WITHIN GROUP \(ORDER BY p\.code\)/);
    assert.equal(inJson('$2'), '(SELECT value FROM OPENJSON($2))');
    assert.equal(page('$3', '$4'), 'OFFSET $3 ROWS FETCH NEXT $4 ROWS ONLY');
  });
});
