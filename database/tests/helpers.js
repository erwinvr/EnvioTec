import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

function secret(name) {
  const file = process.env[`${name}_FILE`];
  if (!file) throw new Error(`Falta ${name}_FILE: estos tests se ejecutan en scripts/check.sh`);
  return readFileSync(file, 'utf8').trim();
}

export async function connect(kind) {
  const url = secret(kind === 'owner' ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL');
  const client = new pg.Client({ connectionString: url, application_name: `enviotec-db-tests-${kind}` });
  await client.connect();
  return client;
}

// Runs fn inside a transaction that is always rolled back, so tests never
// leave data behind.
export async function inRollback(client, fn) {
  await client.query('BEGIN');
  try {
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

// Asserts that a statement fails, without aborting the surrounding
// transaction (uses a savepoint).
export async function expectFailure(client, sql, params, pattern) {
  await client.query('SAVEPOINT expect_failure');
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expect_failure');
    assert.match(`${error.code} ${error.message}`, pattern);
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expect_failure');
  assert.fail(`se esperaba un error: ${sql}`);
}

export async function insertArea(client, name = `Área ${Math.random().toString(36).slice(2, 8)}`) {
  const { rows } = await client.query('INSERT INTO areas (name) VALUES ($1) RETURNING id', [name]);
  return rows[0].id;
}

export async function insertLocalUser(client, areaId, suffix = Math.random().toString(36).slice(2, 8)) {
  const { rows } = await client.query(
    `INSERT INTO users (username, email, display_name, auth_source, password_hash, area_id, expires_at)
     VALUES ($1, $2, 'Usuario de prueba', 'local', '$argon2id$v=19$m=19456,t=2,p=1$x$y', $3, now() + interval '90 days')
     RETURNING id`,
    [`local.${suffix}`, `local.${suffix}@example.test`, areaId],
  );
  return rows[0].id;
}

export async function insertAdUser(client, suffix = Math.random().toString(36).slice(2, 8)) {
  const { rows } = await client.query(
    `INSERT INTO users (username, email, display_name, auth_source, ad_object_guid)
     VALUES ($1, $2, 'Usuario AD', 'ad', gen_random_uuid()) RETURNING id`,
    [`ad.${suffix}`, `ad.${suffix}@example.test`],
  );
  return rows[0].id;
}

export async function roleId(client, name) {
  const { rows } = await client.query('SELECT id FROM roles WHERE name = $1', [name]);
  return rows[0].id;
}
