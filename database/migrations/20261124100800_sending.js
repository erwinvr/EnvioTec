import { NOW } from '../scripts/lib/sql-checks.js';

// Sending through Mandrill and event synchronization (ADR-005, ADR-024,
// ADR-029).
// - send_batches: each batch moves pending -> in_flight -> accepted; a
//   timeout after sending makes it "ambiguous" until reconciled.
// - message_events: tracking events kept locally (Mandrill keeps them 30
//   days), partitioned by month, idempotent by a derived key, with the
//   details of opens and clicks (IP, location, user agent, device, system,
//   mail client). The previous month exists too, for events of 30 days ago.
// - sync_state: cursors of the synchronization.

export const up = `
CREATE TABLE send_batches (
  id          uniqueidentifier NOT NULL CONSTRAINT send_batches_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  campaign_id uniqueidentifier NOT NULL CONSTRAINT send_batches_campaign_id_fkey REFERENCES campaigns (id),
  status      varchar(10) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_flight', 'accepted', 'ambiguous', 'failed', 'cancelled')),
  size        int NOT NULL CHECK (size > 0),
  attempts    int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  accepted    int NULL CHECK (accepted >= 0),
  rejected    int NULL CHECK (rejected >= 0),
  error       nvarchar(200) NULL,
  queued_at   datetime2(3) NULL,
  created_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  sent_at     datetime2(3) NULL
);
CREATE INDEX send_batches_campaign_idx ON send_batches (campaign_id, status);

ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_batch_fkey FOREIGN KEY (batch_id) REFERENCES send_batches (id);
CREATE INDEX campaign_recipients_batch_idx ON campaign_recipients (batch_id);
GO

DECLARE @previous datetime2(3) = DATEADD(month, -1, DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1));
DECLARE @sql nvarchar(max) = N'CREATE PARTITION FUNCTION pf_message_events (datetime2(3)) AS RANGE RIGHT FOR VALUES (''' + CONVERT(nvarchar(30), @previous, 126) + N''')';
EXEC (@sql);
GO
CREATE PARTITION SCHEME ps_message_events AS PARTITION pf_message_events ALL TO ([PRIMARY]);
GO

CREATE TABLE message_events (
  id              uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID(),
  campaign_id     uniqueidentifier NOT NULL CONSTRAINT message_events_campaign_id_fkey REFERENCES campaigns (id),
  recipient_id    uniqueidentifier NULL CONSTRAINT message_events_recipient_id_fkey REFERENCES campaign_recipients (id),
  message_id      varchar(100) NOT NULL,
  event_type      varchar(15) NOT NULL
                    CHECK (event_type IN ('sent', 'open', 'click', 'hard_bounce', 'soft_bounce', 'spam', 'unsubscribe', 'reject', 'deferral')),
  occurred_at     datetime2(3) NOT NULL,
  url             nvarchar(2000) NULL,
  idempotency_key varbinary(32) NOT NULL CHECK (DATALENGTH(idempotency_key) = 32),
  ip              varchar(45) NULL,
  location        nvarchar(200) NULL,
  user_agent      nvarchar(500) NULL,
  device          varchar(30) NULL,
  os              nvarchar(50) NULL,
  client          nvarchar(50) NULL,
  created_at      datetime2(3) NOT NULL DEFAULT ${NOW},
  CONSTRAINT message_events_pkey PRIMARY KEY CLUSTERED (occurred_at, id),
  CONSTRAINT message_events_idempotency_key_occurred_at_key UNIQUE (idempotency_key, occurred_at)
) ON ps_message_events (occurred_at);
CREATE INDEX message_events_campaign_idx ON message_events (campaign_id, event_type, occurred_at);
CREATE INDEX message_events_recipient_idx ON message_events (recipient_id, occurred_at);
GO

EXEC dbo.create_monthly_partitions 'message_events', 12;
GO

CREATE TABLE sync_state (
  [key]      varchar(100) NOT NULL CONSTRAINT sync_state_pkey PRIMARY KEY,
  value      nvarchar(max) NOT NULL CHECK (ISJSON(value) = 1),
  updated_at datetime2(3) NOT NULL DEFAULT ${NOW}
);

GRANT SELECT, INSERT, UPDATE ON send_batches TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON sync_state TO app_runtime;
GRANT SELECT, INSERT ON message_events TO app_runtime;
-- The sync fills the details of events stored before they were known.
GRANT UPDATE (ip, location, user_agent, device, os, client) ON message_events TO app_runtime;
`;

export const down = `
DROP TABLE sync_state, message_events;
GO
DROP PARTITION SCHEME ps_message_events;
DROP PARTITION FUNCTION pf_message_events;
GO
ALTER TABLE campaign_recipients DROP CONSTRAINT campaign_recipients_batch_fkey;
DROP INDEX campaign_recipients_batch_idx ON campaign_recipients;
DROP TABLE send_batches;
`;
