// Runs fn(client) inside a transaction on a dedicated pool client. Commits if
// fn resolves and rolls back if it throws, so an audited action and its audit
// event are written together or not at all (A7).
export async function withTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
