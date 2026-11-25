import { areaCondition } from '../../core/authorization/area-scope.js';
import { escapeLike, fromLaPaz, isoDate, page, toLaPaz } from '../../core/db/sql.js';

// SQL of the reports (ADR-025, ADR-031). Each recipient's facts come from its
// send status and its tracking events; every query is filtered by area.

const flag = (condition) => `CAST(CASE WHEN ${condition} THEN 1 ELSE 0 END AS bit)`;
const any = (condition) => `MAX(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;

// Recipients matching `where`, with their events summarized. `where`
// (fragments written here, values as parameters) applies to both the
// recipients and the events subquery, so the latter stays narrow.
const facts = (recipientWhere, eventWhere) => `
  SELECT r.id, r.campaign_id, r.email, r.status, r.sent_at, r.error, r.send_at,
         ${flag('e.sent = 1 AND e.hard_bounce = 0 AND e.rejected = 0')} AS delivered,
         COALESCE(e.opens, 0) AS opens, COALESCE(e.clicks, 0) AS clicks,
         ${flag('e.hard_bounce = 1')} AS hard_bounce, ${flag('e.soft_bounce = 1')} AS soft_bounce,
         ${flag('e.complaint = 1')} AS complaint, ${flag('e.unsubscribed = 1')} AS unsubscribed, e.last_event_at
    FROM campaign_recipients r
    LEFT JOIN (
      SELECT recipient_id,
             ${any("event_type = 'sent'")} AS sent,
             COUNT(CASE WHEN event_type = 'open' THEN 1 END) AS opens,
             COUNT(CASE WHEN event_type = 'click' THEN 1 END) AS clicks,
             ${any("event_type = 'hard_bounce'")} AS hard_bounce,
             ${any("event_type = 'soft_bounce'")} AS soft_bounce,
             ${any("event_type = 'reject'")} AS rejected,
             ${any("event_type = 'spam'")} AS complaint,
             ${any("event_type = 'unsubscribe'")} AS unsubscribed,
             MAX(occurred_at) AS last_event_at
        FROM message_events WHERE ${eventWhere} GROUP BY recipient_id
    ) e ON e.recipient_id = r.id
   WHERE ${recipientWhere}`;

const count = (condition) => `COUNT(CASE WHEN ${condition} THEN 1 END)`;
const SUMMARY = `
  COUNT(*) AS recipients,
  ${count("f.status = 'sent'")} AS accepted,
  ${count("f.status = 'rejected'")} AS rejected,
  ${count("f.status = 'suppressed'")} AS suppressed,
  ${count("f.status IN ('pending', 'sending')")} AS pending,
  ${count("f.status IN ('failed', 'cancelled')")} AS not_sent,
  ${count('f.delivered = 1')} AS delivered,
  ${count('f.opens > 0')} AS opened,
  ${count('f.clicks > 0')} AS clicked,
  ${count('f.hard_bounce = 1')} AS hard_bounces,
  ${count('f.soft_bounce = 1')} AS soft_bounces,
  ${count('f.complaint = 1')} AS complaints,
  ${count('f.unsubscribed = 1')} AS unsubscribes`;

const CAMPAIGN = `c.id, c.name, c.subject, c.status, c.area_id, a.name AS area_name, c.started_at, c.finished_at, c.schedule_variable`;

// First and last instant (UTC) of a calendar day in America/La_Paz.
const dayStart = (placeholder) => fromLaPaz(`CAST(${placeholder} AS date)`);
const dayEnd = (placeholder) => fromLaPaz(`DATEADD(day, 1, CAST(${placeholder} AS date))`);

// Allowlists for the recipient filters (A8): values map to fixed SQL.
export const STATUS_FILTERS = {
  sent: "f.status = 'sent'", rejected: "f.status = 'rejected'", suppressed: "f.status = 'suppressed'",
  pending: "f.status IN ('pending', 'sending')", not_sent: "f.status IN ('failed', 'cancelled')",
};
export const EVENT_FILTERS = {
  delivered: 'f.delivered = 1', opened: 'f.opens > 0', clicked: 'f.clicks > 0', hard_bounce: 'f.hard_bounce = 1',
  soft_bounce: 'f.soft_bounce = 1', complaint: 'f.complaint = 1', unsubscribe: 'f.unsubscribed = 1',
};

export function createReportsRepository() {
  return {
    // Campaigns that started sending, with their summary.
    async campaigns(db, scope, { search, from, to, limit, offset }) {
      const params = [];
      const conditions = ['c.started_at IS NOT NULL', areaCondition(scope, 'c.area_id', params)];
      if (search) {
        params.push(`%${escapeLike(search)}%`);
        conditions.push(`c.name LIKE $${params.length} ESCAPE '\\'`);
      }
      if (from) {
        params.push(from);
        conditions.push(`c.started_at >= ${dayStart(`$${params.length}`)}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`c.started_at < ${dayEnd(`$${params.length}`)}`);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const { rows: total } = await db.query(`SELECT COUNT(*) AS total FROM campaigns c ${where}`, params);
      params.push(offset, limit);
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN}, s.*
           FROM (SELECT c.* FROM campaigns c ${where}
                  ORDER BY c.started_at DESC ${page(`$${params.length - 1}`, `$${params.length}`)}) c
           JOIN areas a ON a.id = c.area_id
           CROSS APPLY (SELECT ${SUMMARY} FROM (${facts('r.campaign_id = c.id', 'campaign_id = c.id')}) f) s
          ORDER BY c.started_at DESC`,
        params,
      );
      return { rows, total: total[0].total };
    },

    async campaign(db, scope, id) {
      const params = [id];
      const { rows } = await db.query(
        `SELECT ${CAMPAIGN}, s.*
           FROM campaigns c JOIN areas a ON a.id = c.area_id
           CROSS APPLY (SELECT ${SUMMARY} FROM (${facts('r.campaign_id = c.id', 'campaign_id = c.id')}) f) s
          WHERE c.id = $1 AND ${areaCondition(scope, 'c.area_id', params)}`,
        params,
      );
      return rows[0] ?? null;
    },

    // Dashboard (ADR-031): campaigns that started sending in the period
    // (dates in America/La_Paz), within the area scope. Figures per
    // recipient as in each campaign report; the daily series covers the
    // period's days; devices are distinct recipients that opened per device.
    async overview(db, scope, { from, to }) {
      const params = [from, to];
      const inScope = areaCondition(scope, 'c.area_id', params);
      const scoped = `WITH scoped AS (
        SELECT c.id FROM campaigns c WHERE c.started_at >= ${dayStart('$1')} AND c.started_at < ${dayEnd('$2')} AND ${inScope})`;
      const localDay = (column) => `CAST(${toLaPaz(column)} AS date)`;
      const { rows: [totals] } = await db.query(
        `${scoped}
         SELECT (SELECT COUNT(*) FROM scoped) AS campaigns, ${SUMMARY}
           FROM (${facts('r.campaign_id IN (SELECT id FROM scoped)', 'campaign_id IN (SELECT id FROM scoped)')}) f`,
        params,
      );
      const { rows: daily } = await db.query(
        `${scoped},
         days AS (SELECT DATEADD(day, value, CAST($1 AS date)) AS day FROM GENERATE_SERIES(0, DATEDIFF(day, CAST($1 AS date), CAST($2 AS date)))),
         sent AS (
           SELECT ${localDay('sent_at')} AS day, COUNT(*) AS sent
             FROM campaign_recipients
            WHERE campaign_id IN (SELECT id FROM scoped) AND sent_at >= ${dayStart('$1')} AND sent_at < ${dayEnd('$2')}
            GROUP BY ${localDay('sent_at')}),
         events AS (
           SELECT ${localDay('occurred_at')} AS day,
                  COUNT(DISTINCT CASE WHEN event_type = 'open' THEN recipient_id END) AS opened,
                  COUNT(DISTINCT CASE WHEN event_type = 'click' THEN recipient_id END) AS clicked
             FROM message_events
            WHERE campaign_id IN (SELECT id FROM scoped) AND event_type IN ('open', 'click')
              AND occurred_at >= ${dayStart('$1')} AND occurred_at < ${dayEnd('$2')}
            GROUP BY ${localDay('occurred_at')})
         SELECT ${isoDate('d.day')} AS day, COALESCE(s.sent, 0) AS sent,
                COALESCE(e.opened, 0) AS opened, COALESCE(e.clicked, 0) AS clicked
           FROM days d LEFT JOIN sent s ON s.day = d.day LEFT JOIN events e ON e.day = d.day
          ORDER BY d.day`,
        params,
      );
      const { rows: devices } = await db.query(
        `${scoped}
         SELECT COALESCE(device, 'unknown') AS device, COUNT(DISTINCT recipient_id) AS recipients
           FROM message_events
          WHERE campaign_id IN (SELECT id FROM scoped) AND event_type = 'open'
          GROUP BY COALESCE(device, 'unknown') ORDER BY recipients DESC, device`,
        params,
      );
      return { totals, daily, devices };
    },

    // Recipients of a campaign already checked to be in scope.
    async recipients(db, campaignId, { status, event, limit, offset }) {
      const conditions = ['1 = 1'];
      if (status) conditions.push(STATUS_FILTERS[status]);
      if (event) conditions.push(EVENT_FILTERS[event]);
      const base = `FROM (${facts('r.campaign_id = $1', 'campaign_id = $1')}) f WHERE ${conditions.join(' AND ')}`;
      const { rows: total } = await db.query(`SELECT COUNT(*) AS total ${base}`, [campaignId]);
      const { rows } = await db.query(`SELECT f.* ${base} ORDER BY f.email ${page('$2', '$3')}`, [campaignId, offset, limit]);
      return { rows, total: total[0].total };
    },

    // Sending by each contact's date (ADR-030): figures per scheduled day
    // (America/La_Paz), for a campaign already checked to be in scope.
    async byDay(db, campaignId) {
      const day = isoDate(`CAST(${toLaPaz('f.send_at')} AS date)`);
      const { rows } = await db.query(
        `SELECT TOP (400) ${day} AS day, ${SUMMARY}
           FROM (${facts('r.campaign_id = $1', 'campaign_id = $1')}) f
          GROUP BY ${day} ORDER BY day`,
        [campaignId],
      );
      return rows;
    },

    // Events of one recipient of a campaign already checked to be in scope,
    // with the details of opens and clicks (ADR-029).
    async recipientEvents(db, campaignId, recipientId) {
      const { rows } = await db.query(
        `SELECT TOP (500) e.event_type, e.occurred_at, e.url, e.ip, e.location, e.user_agent, e.device, e.os, e.client
           FROM message_events e
          WHERE e.campaign_id = $1 AND e.recipient_id = $2
          ORDER BY e.occurred_at, e.event_type`,
        [campaignId, recipientId],
      );
      return rows;
    },

    // Everything sent to one address, in the campaigns within scope.
    async contact(db, scope, email, { limit, offset }) {
      const params = [email];
      const inScope = areaCondition(scope, 'c.area_id', params);
      const base = `FROM (${facts('r.email = $1', 'recipient_id IN (SELECT id FROM campaign_recipients WHERE email = $1)')}) f
                    JOIN campaigns c ON c.id = f.campaign_id JOIN areas a ON a.id = c.area_id
                   WHERE ${inScope}`;
      const { rows: total } = await db.query(`SELECT COUNT(*) AS total ${base}`, params);
      params.push(offset, limit);
      const { rows } = await db.query(
        `SELECT f.*, c.name AS campaign_name, a.name AS area_name, c.started_at ${base}
          ORDER BY CASE WHEN c.started_at IS NULL THEN 1 ELSE 0 END, c.started_at DESC
          ${page(`$${params.length - 1}`, `$${params.length}`)}`,
        params,
      );
      return { rows, total: total[0].total };
    },

    // Export in pages of 1000 by id (keyset), so memory stays bounded.
    async* exportRecipients(db, campaignId) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const { rows } = await db.query(
          `WITH batch AS (SELECT TOP (1000) id FROM campaign_recipients WHERE campaign_id = $1 AND id > $2 ORDER BY id)
           SELECT f.* FROM (${facts('r.id IN (SELECT id FROM batch)', 'recipient_id IN (SELECT id FROM batch)')}) f ORDER BY f.id`,
          [campaignId, after],
        );
        if (rows.length === 0) return;
        yield rows;
        after = rows.at(-1).id;
      }
    },
  };
}
