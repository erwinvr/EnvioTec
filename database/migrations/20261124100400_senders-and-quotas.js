import { EMAIL_TYPE, NOW, emailCheck, noLineBreaks } from '../scripts/lib/sql-checks.js';

// Allowed senders per area and send quotas (Parte B, ADR-011, ADR-024).
// - sender_identities: the only From/Reply-To a campaign may use; never
//   deleted, only deactivated, so campaigns keep pointing to them.
// - quotas: one row per user; reserved + consumed never exceed assigned.
// - quota_movements: append-only history (same protection as audit_logs);
//   "refund" gives back what Mandrill did not accept.
// - monthly_send_usage: sends per calendar month (America/La_Paz), locked
//   by row to enforce the global cap.

export const up = `
CREATE TABLE sender_identities (
  id           uniqueidentifier NOT NULL CONSTRAINT sender_identities_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  area_id      uniqueidentifier NOT NULL CONSTRAINT sender_identities_area_id_fkey REFERENCES areas (id),
  email        ${EMAIL_TYPE} NOT NULL CHECK (${emailCheck('email')}),
  display_name nvarchar(100) NOT NULL CHECK (LEN(display_name) BETWEEN 1 AND 100 AND ${noLineBreaks('display_name', '<>"')}),
  reply_to     ${EMAIL_TYPE} NULL CHECK (reply_to IS NULL OR ${emailCheck('reply_to')}),
  is_active    bit NOT NULL DEFAULT 1,
  created_at   datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at   datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by   uniqueidentifier NULL CONSTRAINT sender_identities_created_by_fkey REFERENCES users (id),
  updated_by   uniqueidentifier NULL CONSTRAINT sender_identities_updated_by_fkey REFERENCES users (id),
  CONSTRAINT sender_identities_area_id_email_key UNIQUE (area_id, email)
);
CREATE INDEX sender_identities_created_by_idx ON sender_identities (created_by);
CREATE INDEX sender_identities_updated_by_idx ON sender_identities (updated_by);

CREATE TABLE quotas (
  user_id    uniqueidentifier NOT NULL CONSTRAINT quotas_pkey PRIMARY KEY CONSTRAINT quotas_user_id_fkey REFERENCES users (id),
  assigned   int NOT NULL DEFAULT 0 CHECK (assigned >= 0),
  reserved   int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumed   int NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  created_at datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at datetime2(3) NOT NULL DEFAULT ${NOW},
  CONSTRAINT quotas_within_assigned CHECK (reserved + consumed <= assigned)
);

CREATE TABLE quota_movements (
  id             uniqueidentifier NOT NULL CONSTRAINT quota_movements_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  user_id        uniqueidentifier NOT NULL CONSTRAINT quota_movements_user_id_fkey REFERENCES users (id),
  kind           varchar(10) NOT NULL CONSTRAINT quota_movements_kind_check CHECK (kind IN ('adjust', 'reserve', 'release', 'consume', 'refund')),
  amount         int NOT NULL,
  assigned_after int NOT NULL CHECK (assigned_after >= 0),
  reserved_after int NOT NULL CHECK (reserved_after >= 0),
  consumed_after int NOT NULL CHECK (consumed_after >= 0),
  campaign_id    uniqueidentifier NULL,
  reason         nvarchar(500) NULL CHECK (reason IS NULL OR LEN(reason) BETWEEN 1 AND 500),
  actor_user_id  uniqueidentifier NULL CONSTRAINT quota_movements_actor_user_id_fkey REFERENCES users (id),
  occurred_at    datetime2(3) NOT NULL DEFAULT ${NOW},
  CONSTRAINT quota_movements_amount CHECK (amount <> 0 AND (kind = 'adjust' OR amount > 0)),
  CONSTRAINT quota_movements_adjust_reason CHECK (kind <> 'adjust' OR (reason IS NOT NULL AND actor_user_id IS NOT NULL))
);
CREATE INDEX quota_movements_user_idx ON quota_movements (user_id, occurred_at DESC);
CREATE INDEX quota_movements_campaign_idx ON quota_movements (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX quota_movements_actor_idx ON quota_movements (actor_user_id);
GO

-- Same defense in depth as audit_logs: the history never changes.
CREATE TRIGGER quota_movements_no_update ON quota_movements INSTEAD OF UPDATE, DELETE
AS
BEGIN
  THROW 51001, 'quota_movements is append-only', 1;
END
GO

CREATE TABLE monthly_send_usage (
  month      date NOT NULL CONSTRAINT monthly_send_usage_pkey PRIMARY KEY CHECK (DAY(month) = 1),
  sent       int NOT NULL DEFAULT 0 CHECK (sent >= 0),
  updated_at datetime2(3) NOT NULL DEFAULT ${NOW}
);

GRANT SELECT, INSERT, UPDATE ON sender_identities TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON quotas TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON monthly_send_usage TO app_runtime;
GRANT SELECT, INSERT ON quota_movements TO app_runtime;
`;

export const down = 'DROP TABLE monthly_send_usage, quota_movements, quotas, sender_identities;';
