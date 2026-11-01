import { areaCondition } from '../../core/authorization/area-scope.js';

// SQL of quotas (ADR-011). Every change locks the quota row (FOR UPDATE);
// the global cap locks the month's row in monthly_send_usage.

const CURRENT_MONTH = "date_trunc('month', now() AT TIME ZONE 'America/La_Paz')::date";

export function createQuotasRepository() {
  return {
    // Locks (creating if missing) the user's quota row.
    async lock(db, userId) {
      await db.query('INSERT INTO quotas (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
      const { rows } = await db.query('SELECT assigned, reserved, consumed FROM quotas WHERE user_id = $1 FOR UPDATE', [userId]);
      return rows[0];
    },

    async save(db, userId, quota) {
      await db.query('UPDATE quotas SET assigned = $2, reserved = $3, consumed = $4 WHERE user_id = $1',
        [userId, quota.assigned, quota.reserved, quota.consumed]);
    },

    async addMovement(db, { userId, kind, amount, quota, campaignId = null, reason = null, actorId = null }) {
      const { rows } = await db.query(
        `INSERT INTO quota_movements (user_id, kind, amount, assigned_after, reserved_after, consumed_after, campaign_id,
                                      reason, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [userId, kind, amount, quota.assigned, quota.reserved, quota.consumed, campaignId, reason, actorId],
      );
      return rows[0].id;
    },

    async find(db, userId) {
      const { rows } = await db.query('SELECT assigned, reserved, consumed FROM quotas WHERE user_id = $1', [userId]);
      return rows[0] ?? { assigned: 0, reserved: 0, consumed: 0 };
    },

    async findUserInScope(db, scope, userId) {
      const params = [userId];
      const condition = areaCondition(scope, 'u.area_id', params);
      const { rows } = await db.query(
        `SELECT u.id, u.username FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL AND ${condition}`,
        params,
      );
      return rows[0] ?? null;
    },

    async list(db, scope, { search, limit, offset }) {
      const params = [];
      const conditions = ['u.deleted_at IS NULL', areaCondition(scope, 'u.area_id', params)];
      if (search) {
        params.push(`%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
        conditions.push(`(u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows: count } = await db.query(`SELECT count(*)::int AS total FROM users u ${where}`, params);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT u.id, u.username, u.display_name, a.name AS area_name,
                coalesce(q.assigned, 0) AS assigned, coalesce(q.reserved, 0) AS reserved, coalesce(q.consumed, 0) AS consumed
           FROM users u LEFT JOIN quotas q ON q.user_id = u.id LEFT JOIN areas a ON a.id = u.area_id
          ${where}
          ORDER BY u.username
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    async movements(db, userId, { limit, offset }) {
      const { rows: count } = await db.query('SELECT count(*)::int AS total FROM quota_movements WHERE user_id = $1', [userId]);
      const { rows } = await db.query(
        `SELECT m.id, m.kind, m.amount, m.assigned_after, m.reserved_after, m.consumed_after, m.campaign_id, m.reason,
                m.occurred_at, a.username AS actor_username
           FROM quota_movements m LEFT JOIN users a ON a.id = m.actor_user_id
          WHERE m.user_id = $1
          ORDER BY m.occurred_at DESC, m.id DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
      return { rows, total: count[0].total };
    },

    async monthlyCap(db) {
      const { rows } = await db.query("SELECT value FROM system_settings WHERE key = 'sending.monthly_global_cap'");
      return Number(rows[0].value);
    },

    // Locks (creating if missing) the current month's usage row.
    async lockMonth(db) {
      await db.query(`INSERT INTO monthly_send_usage (month) VALUES (${CURRENT_MONTH}) ON CONFLICT (month) DO NOTHING`);
      const { rows } = await db.query(
        `SELECT to_char(month, 'YYYY-MM-DD') AS month, sent FROM monthly_send_usage WHERE month = ${CURRENT_MONTH} FOR UPDATE`,
      );
      return rows[0];
    },

    async addToMonth(db, month, amount) {
      await db.query('UPDATE monthly_send_usage SET sent = sent + $2 WHERE month = $1::date', [month, amount]);
    },

    async currentMonth(db) {
      const { rows } = await db.query(
        `SELECT to_char(${CURRENT_MONTH}, 'YYYY-MM') AS month, coalesce((SELECT sent FROM monthly_send_usage WHERE month = ${CURRENT_MONTH}), 0) AS sent`,
      );
      return rows[0];
    },
  };
}
