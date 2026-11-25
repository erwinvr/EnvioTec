// Verification of the audit hash chain (A7, ADR-018, ADR-032). Walks the log
// in insert order (seq), recomputes every hash with audit_log_canonical() and checks
// that each prev_hash is the hash of the row before it:
//   altered row          its stored hash no longer matches its content
//   deleted or inserted  the next row's prev_hash does not match
// Gaps in seq are normal (a rolled-back insert consumes a value) and are not
// reported.

const BATCH = 1000;

const ROWS = `
  SELECT TOP ($2) seq, id, occurred_at, action, hash, prev_hash,
         CAST(CASE WHEN hash = dbo.audit_log_canonical(id, occurred_at, actor_type, actor_user_id, actor_session_id, action,
                                                       resource_type, resource_id, result, ip, user_agent, request_id,
                                                       metadata, prev_hash)
                   THEN 1 ELSE 0 END AS bit) AS valid
    FROM audit_logs
   WHERE seq > $1
   ORDER BY seq`;

// Returns { checked, firstSeq, lastSeq, problem } where problem is null or
// { seq, id, reason: 'altered' | 'broken_link' }.
export async function verifyAuditChain(client, { from = null } = {}) {
  let afterSeq = 0;
  let previousHash = null;

  if (from) {
    const { rows } = await client.query(
      'SELECT TOP (1) seq FROM audit_logs WHERE occurred_at >= $1 ORDER BY seq',
      [from],
    );
    if (rows.length === 0) return { checked: 0, firstSeq: null, lastSeq: null, problem: null };
    // The first row checked must link to the row right before it.
    const { rows: before } = await client.query(
      'SELECT TOP (1) seq, hash FROM audit_logs WHERE seq < $1 ORDER BY seq DESC',
      [rows[0].seq],
    );
    if (before.length > 0) {
      afterSeq = Number(before[0].seq);
      previousHash = before[0].hash;
    }
  }

  let checked = 0;
  let firstSeq = null;
  let lastSeq = null;
  for (;;) {
    const { rows } = await client.query(ROWS, [afterSeq, BATCH]);
    if (rows.length === 0) break;
    for (const row of rows) {
      firstSeq ??= Number(row.seq);
      const linked = previousHash === null ? row.prev_hash === null : row.prev_hash?.equals(previousHash) === true;
      if (!row.valid) return { checked, firstSeq, lastSeq, problem: { seq: Number(row.seq), id: row.id, reason: 'altered' } };
      if (!linked) return { checked, firstSeq, lastSeq, problem: { seq: Number(row.seq), id: row.id, reason: 'broken_link' } };
      previousHash = row.hash;
      lastSeq = Number(row.seq);
      checked += 1;
    }
    afterSeq = lastSeq;
  }
  return { checked, firstSeq, lastSeq, problem: null };
}
