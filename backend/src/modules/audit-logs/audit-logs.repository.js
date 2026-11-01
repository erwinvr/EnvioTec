// SQL for querying the audit log (A7). Every filter is a bound parameter;
// the sort order is fixed (newest first), so nothing from the request is
// ever interpolated.

const COLUMNS = `
  a.seq, a.id, a.occurred_at, a.actor_type, a.actor_user_id, u.username AS actor_username, a.action,
  a.resource_type, a.resource_id, a.result, host(a.ip) AS ip, a.user_agent, a.request_id, a.metadata`;

function whereClause(filters, params) {
  const conditions = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.from) add('a.occurred_at >= ?', filters.from);
  if (filters.to) add('a.occurred_at < ?', filters.to);
  if (filters.actorUserId) add('a.actor_user_id = ?', filters.actorUserId);
  if (filters.action) add('a.action = ?', filters.action);
  if (filters.resourceType) add('a.resource_type = ?', filters.resourceType);
  if (filters.resourceId) add('a.resource_id = ?', filters.resourceId);
  if (filters.result) add('a.result = ?', filters.result);
  if (filters.requestId) add('a.request_id = ?', filters.requestId);
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
}

export function createAuditLogsRepository(db) {
  return {
    async count(filters) {
      const params = [];
      const { rows } = await db.query(`SELECT count(*)::int AS total FROM audit_logs a ${whereClause(filters, params)}`, params);
      return rows[0].total;
    },

    async findPage(filters, { limit, offset }) {
      const params = [];
      const where = whereClause(filters, params);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
          ${where}
          ORDER BY a.seq DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows;
    },

    // Keyset pagination for exports: rows with seq below `beforeSeq`.
    async findBatch(client, filters, { beforeSeq, limit }) {
      const params = [];
      const where = whereClause(filters, params);
      params.push(beforeSeq, limit);
      const { rows } = await client.query(
        `SELECT ${COLUMNS} FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
          ${where ? `${where} AND` : 'WHERE'} a.seq < $${params.length - 1}
          ORDER BY a.seq DESC
          LIMIT $${params.length}`,
        params,
      );
      return rows;
    },
  };
}
