import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectionOptions } from '../../backend/src/core/db/connection-url.js';
import { connectDatabase } from '../../backend/src/core/db/pool.js';

const read = (path) => readFileSync(path, 'utf8').replace(/\r?\n$/, '');

// Connections of the database tests (ADR-032): the owner login, which has
// every table privilege (the guards must hold even then), or the runtime one.
// TLS as in the application: the CA and server name of the environment.
export function connect(kind) {
  const variable = kind === 'owner' ? 'MIGRATION_DATABASE_URL_FILE' : 'DATABASE_URL_FILE';
  if (!process.env[variable]) throw new Error(`Falta ${variable}: estos tests se ejecutan en scripts/check.sh`);
  return connectDatabase({
    ...connectionOptions({
      url: read(process.env[variable]),
      caCert: process.env.DATABASE_CA_CERT_FILE ? read(process.env.DATABASE_CA_CERT_FILE) : undefined,
      serverName: process.env.DATABASE_SERVER_NAME || undefined,
      trustServerCertificate: process.env.DATABASE_TRUST_SERVER_CERTIFICATE === 'true',
    }, `enviotec-db-tests-${kind}`),
    requestTimeout: 60000,
  });
}

// Runs fn(tx) inside a transaction that is always rolled back, so tests never
// leave data behind.
export async function inRollback(db, fn) {
  const tx = await db.connect();
  await tx.begin();
  try {
    return await fn(tx);
  } finally {
    await tx.rollback();
  }
}

// fn(tx) prepares what it needs and runs a statement that must fail with an
// error matching `pattern`. Each case gets its own transaction, always rolled
// back: in SQL Server an error raised by a trigger rolls back the whole
// transaction, so a failure never shares its transaction with the next case.
export async function failsWith(db, pattern, fn) {
  const tx = await db.connect();
  await tx.begin();
  try {
    await fn(tx);
  } catch (error) {
    assert.match(`${error.code} ${error.message}`, pattern);
    return;
  } finally {
    await tx.rollback();
  }
  assert.fail(`se esperaba un error que coincida con ${pattern}`);
}

// A single statement that must fail, in its own rolled-back transaction.
export const expectFailure = (db, sql, params, pattern) => failsWith(db, pattern, (tx) => tx.query(sql, params));

export async function insertArea(db, name = `Área ${Math.random().toString(36).slice(2, 8)}`) {
  const { rows } = await db.query('INSERT INTO areas (name) OUTPUT inserted.id VALUES ($1)', [name]);
  return rows[0].id;
}

export async function insertLocalUser(db, areaId, suffix = Math.random().toString(36).slice(2, 8)) {
  const { rows } = await db.query(
    `DECLARE @out TABLE (id uniqueidentifier);
     INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, expires_at)
     OUTPUT inserted.id INTO @out
     VALUES ($1, $2, 'Usuario de prueba', 'local', '$argon2id$v=19$m=19456,t=2,p=1$x$y', $3, DATEADD(day, 90, SYSUTCDATETIME()));
     SELECT id FROM @out;`,
    [`local.${suffix}`, `local.${suffix}@example.test`, areaId],
  );
  return rows[0].id;
}

export async function insertAdUser(db, suffix = Math.random().toString(36).slice(2, 8)) {
  const { rows } = await db.query(
    `DECLARE @out TABLE (id uniqueidentifier);
     INSERT INTO users (username, email, display_name, auth_source, ad_object_guid)
     OUTPUT inserted.id INTO @out VALUES ($1, $2, 'Usuario AD', 'ad', NEWID());
     SELECT id FROM @out;`,
    [`ad.${suffix}`, `ad.${suffix}@example.test`],
  );
  return rows[0].id;
}

export async function roleId(db, name) {
  const { rows } = await db.query('SELECT id FROM roles WHERE name = $1', [name]);
  return rows[0].id;
}

// An audit event through the only path the application has (A7).
export function appendAudit(db, action, { metadata = '{}', ip = null } = {}) {
  return db.query(
    `DECLARE @id uniqueidentifier;
     EXEC dbo.append_audit_log @actor_type = 'system', @actor_user_id = NULL, @actor_session_id = NULL, @action = $1,
          @resource_type = 'test', @resource_id = '1', @result = 'success', @ip = $2, @user_agent = 'ua',
          @request_id = 'req', @metadata = $3, @id = @id OUTPUT;
     SELECT @id AS id;`,
    [action, ip, metadata],
  );
}
