// Runs fn(client) inside a transaction on a dedicated connection. Commits if
// fn resolves and rolls back if it throws, so an audited action and its audit
// event are written together or not at all (A7).
export async function withTransaction(db, fn) {
  const client = await db.connect();
  await client.begin();
  try {
    const result = await fn(client);
    await client.commit();
    return result;
  } catch (error) {
    await client.rollback();
    throw error;
  }
}

// Exclusive lock named `name`, held until the end of the caller's
// transaction (sp_getapplock): the SQL Server equivalent of an advisory lock.
export async function lockName(client, name, { timeoutMs = 15000 } = {}) {
  const { rows } = await client.query(
    `DECLARE @status int;
     EXEC @status = sp_getapplock @Resource = $1, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = $2;
     SELECT @status AS status`,
    [name, timeoutMs],
  );
  if (rows[0].status < 0) throw Object.assign(new Error(`lock not acquired: ${name}`), { code: '55P03' });
}

// Like lockName, but returns false at once if someone else holds it.
export async function tryLockName(client, name) {
  const { rows } = await client.query(
    `DECLARE @status int;
     EXEC @status = sp_getapplock @Resource = $1, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
     SELECT @status AS status`,
    [name],
  );
  return rows[0].status >= 0;
}
