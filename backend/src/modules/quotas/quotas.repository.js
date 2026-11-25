import { areaCondition } from '../../core/authorization/area-scope.js';
import { LA_PAZ_MONTH, escapeLike, isoDate, page, returning } from '../../core/db/sql.js';

// SQL of quotas (ADR-011). Every change locks the quota row (UPDLOCK); the
// global cap locks the month's row in monthly_send_usage. HOLDLOCK on the
// existence check makes "create if missing" safe under concurrency.

export function createQuotasRepository() {
  return {
    // Locks (creating if missing) the user's quota row.
    async lock(db, userId) {
      const { rows } = await db.query(
        `IF NOT EXISTS (SELECT 1 FROM quotas WITH (UPDLOCK, HOLDLOCK) WHERE user_id = $1)
           INSERT INTO quotas (user_id) VALUES ($1);
         SELECT assigned, reserved, consumed FROM quotas WITH (UPDLOCK, ROWLOCK) WHERE user_id = $1;`,
        [userId],
      );
      return rows[0];
    },

    async save(db, userId, quota) {
      await db.query(
        'UPDATE quotas SET assigned = $2, reserved = $3, consumed = $4, updated_at = SYSUTCDATETIME() WHERE user_id = $1',
        [userId, quota.assigned, quota.reserved, quota.consumed],
      );
    },

    // quota_movements is append-only (guard trigger): OUTPUT through a table variable.
    async addMovement(db, { userId, kind, amount, quota, campaignId = null, reason = null, actorId = null }) {
      const out = returning({ id: 'uniqueidentifier' });
      const { rows } = await db.query(
        `${out.declare}
         INSERT INTO quota_movements (user_id, kind, amount, assigned_after, reserved_after, consumed_after, campaign_id,
                                      reason, actor_user_id)
         ${out.output}
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
         ${out.select}`,
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
        params.push(`%${escapeLike(search)}%`);
        conditions.push(`(u.username LIKE $${params.length} ESCAPE '\\' OR u.display_name LIKE $${params.length} ESCAPE '\\')`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows: count } = await db.query(`SELECT COUNT(*) AS total FROM users u ${where}`, params);
      params.push(offset, limit);
      const { rows } = await db.query(
        `SELECT u.id, u.username, u.display_name, a.name AS area_name,
                COALESCE(q.assigned, 0) AS assigned, COALESCE(q.reserved, 0) AS reserved, COALESCE(q.consumed, 0) AS consumed
           FROM users u LEFT JOIN quotas q ON q.user_id = u.id LEFT JOIN areas a ON a.id = u.area_id
          ${where}
          ORDER BY u.username
          ${page(`$${params.length - 1}`, `$${params.length}`)}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    async movements(db, userId, { limit, offset }) {
      const { rows: count } = await db.query('SELECT COUNT(*) AS total FROM quota_movements WHERE user_id = $1', [userId]);
      const { rows } = await db.query(
        `SELECT m.id, m.kind, m.amount, m.assigned_after, m.reserved_after, m.consumed_after, m.campaign_id, m.reason,
                m.occurred_at, a.username AS actor_username
           FROM quota_movements m LEFT JOIN users a ON a.id = m.actor_user_id
          WHERE m.user_id = $1
          ORDER BY m.occurred_at DESC, m.id DESC
          ${page('$2', '$3')}`,
        [userId, offset, limit],
      );
      return { rows, total: count[0].total };
    },

    async monthlyCap(db) {
      const { rows } = await db.query("SELECT value FROM system_settings WHERE [key] = 'sending.monthly_global_cap'");
      return Number(rows[0].value);
    },

    // Locks (creating if missing) the current month's usage row.
    async lockMonth(db) {
      const { rows } = await db.query(
        `DECLARE @month date = ${LA_PAZ_MONTH};
         IF NOT EXISTS (SELECT 1 FROM monthly_send_usage WITH (UPDLOCK, HOLDLOCK) WHERE month = @month)
           INSERT INTO monthly_send_usage (month) VALUES (@month);
         SELECT ${isoDate('month')} AS month, sent FROM monthly_send_usage WITH (UPDLOCK, ROWLOCK) WHERE month = @month;`,
      );
      return rows[0];
    },

    async addToMonth(db, month, amount) {
      await db.query(
        'UPDATE monthly_send_usage SET sent = sent + $2, updated_at = SYSUTCDATETIME() WHERE month = CAST($1 AS date)',
        [month, amount],
      );
    },

    async currentMonth(db) {
      const { rows } = await db.query(
        `SELECT CONVERT(char(7), ${LA_PAZ_MONTH}, 23) AS month,
                COALESCE((SELECT sent FROM monthly_send_usage WHERE month = ${LA_PAZ_MONTH}), 0) AS sent`,
      );
      return rows[0];
    },
  };
}
