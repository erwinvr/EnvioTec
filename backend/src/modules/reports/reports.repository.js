import { areaCondition } from '../../core/authorization/area-scope.js';

// SQL of the reports (ADR-025). Each recipient's facts come from its send
// status and its tracking events; every query is filtered by area.

const escapeLike = (text) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

// Recipients matching `where`, with their events summarized. `where`
// (fragments written here, values as parameters) applies to both the
// recipients and the events subquery, so the latter stays narrow.
const facts = (recipientWhere, eventWhere) => `
  SELECT r.id, r.campaign_id, r.email::text AS email, r.status, r.sent_at, r.error,
         coalesce(e.sent AND NOT e.hard_bounce AND NOT e.rejected, false) AS delivered,
         coalesce(e.opens, 0) AS opens, coalesce(e.clicks, 0) AS clicks,
         coalesce(e.hard_bounce, false) AS hard_bounce, coalesce(e.soft_bounce, false) AS soft_bounce,
         coalesce(e.complaint, false) AS complaint, coalesce(e.unsubscribed, false) AS unsubscribed, e.last_event_at
    FROM campaign_recipients r
    LEFT JOIN (
      SELECT recipient_id,
             bool_or(event_type = 'sent') AS sent,
             count(*) FILTER (WHERE event_type = 'open')::int AS opens,
             count(*) FILTER (WHERE event_type = 'click')::int AS clicks,
             bool_or(event_type = 'hard_bounce') AS hard_bounce,
             bool_or(event_type = 'soft_bounce') AS soft_bounce,
             bool_or(event_type = 'reject') AS rejected,
             bool_or(event_type = 'spam') AS complaint,
             bool_or(event_type = 'unsubscribe') AS unsubscribed,
             max(occurred_at) AS last_event_at
        FROM message_events WHERE ${eventWhere} GROUP BY recipient_id
    ) e ON e.recipient_id = r.id
   WHERE ${recipientWhere}`;

const SUMMARY = `
  count(*)::int AS recipients,
  count(*) FILTER (WHERE f.status = 'sent')::int AS accepted,
  count(*) FILTER (WHERE f.status = 'rejected')::int AS rejected,
  count(*) FILTER (WHERE f.status = 'suppressed')::int AS suppressed,
  count(*) FILTER (WHERE f.status IN ('pending', 'sending'))::int AS pending,
  count(*) FILTER (WHERE f.status IN ('failed', 'cancelled'))::int AS not_sent,
  count(*) FILTER (WHERE f.delivered)::int AS delivered,
  count(*) FILTER (WHERE f.opens > 0)::int AS opened,
  count(*) FILTER (WHERE f.clicks > 0)::int AS clicked,
  count(*) FILTER (WHERE f.hard_bounce)::int AS hard_bounces,
  count(*) FILTER (WHERE f.soft_bounce)::int AS soft_bounces,
  count(*) FILTER (WHERE f.complaint)::int AS complaints,
  count(*) FILTER (WHERE f.unsubscribed)::int AS unsubscribes`;

const CAMPAIGN = `c.id, c.name, c.subject, c.status, c.area_id, a.name AS area_name, c.started_at, c.finished_at`;

// Allowlists for the recipient filters (A8): values map to fixed SQL.
export const STATUS_FILTERS = {
  sent: "f.status = 'sent'", rejected: "f.status = 'rejected'", suppressed: "f.status = 'suppressed'",
  pending: "f.status IN ('pending', 'sending')", not_sent: "f.status IN ('failed', 'cancelled')",
};
export const EVENT_FILTERS = {
  delivered: 'f.delivered', opened: 'f.opens > 0', clicked: 'f.clicks > 0', hard_bounce: 'f.hard_bounce',
  soft_bounce: 'f.soft_bounce', complaint: 'f.complaint', unsubscribe: 'f.unsubscribed',
};

export function createReportsRepository() {
  return {
    // Campaigns that started sending, with their summary.
    async campaigns(db, scope, { search, from, to, limit, offset }) {
      const params = [];
      const conditions = ['c.started_at IS NOT NULL', areaCondition(scope, 'c.area_id', params)];
      if (search) {
        params.push(`%${escapeLike(search)}%`);
        conditions.push(`c.name ILIKE $${params.length}`);
      }
      if (from) {
        params.push(from);
        conditions.push(`c.started_at >= ($${params.length}::date::timestamp AT TIME ZONE 'America/La_Paz')`);
      }
      if (to) {
        params.push(to);
        conditions.push(`c.started_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'America/La_Paz')`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows: count } = await db.query(`SELECT count(*)::int AS total FROM campaigns c ${where}`, params);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN}, s.*
           FROM (SELECT c.* FROM campaigns c ${where} ORDER BY c.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}) c
           JOIN areas a ON a.id = c.area_id
           CROSS JOIN LATERAL (SELECT ${SUMMARY} FROM (${facts('r.campaign_id = c.id', 'campaign_id = c.id')}) f) s
          ORDER BY c.started_at DESC`,
        params,
      );
      return { rows, total: count[0].total };
    },

    async campaign(db, scope, id) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN}, s.*
           FROM campaigns c JOIN areas a ON a.id = c.area_id
           CROSS JOIN LATERAL (SELECT ${SUMMARY} FROM (${facts('r.campaign_id = c.id', 'campaign_id = c.id')}) f) s
          WHERE c.id = $1 AND ${areaCondition(scope, 'c.area_id', params)}`,
        params,
      );
      return rows[0] ?? null;
    },

    // Recipients of a campaign already checked to be in scope.
    async recipients(db, campaignId, { status, event, limit, offset }) {
      const conditions = ['TRUE'];
      if (status) conditions.push(STATUS_FILTERS[status]);
      if (event) conditions.push(EVENT_FILTERS[event]);
      const base = `FROM (${facts('r.campaign_id = $1', 'campaign_id = $1')}) f WHERE ${conditions.join(' AND ')}`;
      const { rows: count } = await db.query(`SELECT count(*)::int AS total ${base}`, [campaignId]);
      const { rows } = await db.query(`SELECT f.* ${base} ORDER BY f.email LIMIT $2 OFFSET $3`, [campaignId, limit, offset]);
      return { rows, total: count[0].total };
    },

    // Everything sent to one address, in the campaigns within scope.
    async contact(db, scope, email, { limit, offset }) {
      const params = [email];
      const inScope = areaCondition(scope, 'c.area_id', params);
      const base = `FROM (${facts('r.email = $1', 'recipient_id IN (SELECT id FROM campaign_recipients WHERE email = $1)')}) f
                    JOIN campaigns c ON c.id = f.campaign_id JOIN areas a ON a.id = c.area_id
                   WHERE ${inScope}`;
      const { rows: count } = await db.query(`SELECT count(*)::int AS total ${base}`, params);
      params.push(limit, offset);
      const { rows } = await db.query(
        `SELECT f.*, c.name AS campaign_name, a.name AS area_name, c.started_at ${base}
          ORDER BY c.started_at DESC NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { rows, total: count[0].total };
    },

    // Export in pages of 1000 by id (keyset), so memory stays bounded.
    async* exportRecipients(db, campaignId) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const { rows } = await db.query(
          `WITH page AS (SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND id > $2 ORDER BY id LIMIT 1000)
           SELECT f.* FROM (${facts('r.id IN (SELECT id FROM page)', 'recipient_id IN (SELECT id FROM page)')}) f ORDER BY f.id`,
          [campaignId, after],
        );
        if (rows.length === 0) return;
        yield rows;
        after = rows.at(-1).id;
      }
    },
  };
}
