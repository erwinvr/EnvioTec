import { EMAIL_TYPE, NOW, emailHash, isJson, noLineBreaks, sha256Hex, variableName } from '../scripts/lib/sql-checks.js';

// Campaigns (Parte B, ADR-011, ADR-027, ADR-030).
// - campaigns: template version + list + optional PDF + sender + schedule
//   (fixed time, or each contact's date variable with an offset in days and
//   a time of day in America/La_Paz); the approver is never who submitted it.
// - campaign_attachments: the single PDF, inspected in the file-processor;
//   its SHA-256 proves which file was sent.
// - campaign_recipients: snapshot taken at approval (suppression applied),
//   with each recipient's send_at; the sender moves them through their states.
// - campaign_test_sends: test sends, at most N per user per day.

export const up = `
CREATE TABLE campaign_attachments (
  id             uniqueidentifier NOT NULL CONSTRAINT campaign_attachments_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  area_id        uniqueidentifier NOT NULL CONSTRAINT campaign_attachments_area_id_fkey REFERENCES areas (id),
  file_id        uniqueidentifier NOT NULL CONSTRAINT campaign_attachments_file_id_key UNIQUE,
  original_name  nvarchar(255) NOT NULL CHECK (LEN(original_name) BETWEEN 1 AND 255),
  size_bytes     int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256         varchar(64) NOT NULL CHECK (${sha256Hex('sha256')}),
  status         varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  failure_reason nvarchar(100) NULL,
  created_by     uniqueidentifier NOT NULL CONSTRAINT campaign_attachments_created_by_fkey REFERENCES users (id),
  created_at     datetime2(3) NOT NULL DEFAULT ${NOW},
  processed_at   datetime2(3) NULL
);
CREATE INDEX campaign_attachments_area_id_idx ON campaign_attachments (area_id);
CREATE INDEX campaign_attachments_created_by_idx ON campaign_attachments (created_by);

CREATE TABLE campaigns (
  id                   uniqueidentifier NOT NULL CONSTRAINT campaigns_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  area_id              uniqueidentifier NOT NULL CONSTRAINT campaigns_area_id_fkey REFERENCES areas (id),
  name                 nvarchar(150) NOT NULL CHECK (LEN(name) BETWEEN 2 AND 150),
  status               varchar(10) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'submitted', 'approved', 'scheduled', 'sending', 'paused', 'completed', 'cancelled')),
  subject              nvarchar(200) NOT NULL CHECK (LEN(subject) BETWEEN 1 AND 200 AND ${noLineBreaks('subject')}),
  template_version_id  uniqueidentifier NOT NULL CONSTRAINT campaigns_template_version_id_fkey REFERENCES template_versions (id),
  list_id              uniqueidentifier NOT NULL CONSTRAINT campaigns_list_id_fkey REFERENCES contact_lists (id),
  sender_id            uniqueidentifier NOT NULL CONSTRAINT campaigns_sender_id_fkey REFERENCES sender_identities (id),
  attachment_id        uniqueidentifier NULL CONSTRAINT campaigns_attachment_id_fkey REFERENCES campaign_attachments (id),
  scheduled_at         datetime2(3) NULL,
  schedule_variable    varchar(40) NULL CHECK (schedule_variable IS NULL OR ${variableName('schedule_variable')}),
  schedule_offset_days int NULL CHECK (schedule_offset_days BETWEEN -365 AND 365),
  schedule_time        time(0) NULL,
  excluded_no_date     int NULL CHECK (excluded_no_date >= 0),
  excluded_past        int NULL CHECK (excluded_past >= 0),
  excluded_too_far     int NULL CHECK (excluded_too_far >= 0),
  created_by           uniqueidentifier NOT NULL CONSTRAINT campaigns_created_by_fkey REFERENCES users (id),
  updated_by           uniqueidentifier NULL CONSTRAINT campaigns_updated_by_fkey REFERENCES users (id),
  submitted_by         uniqueidentifier NULL CONSTRAINT campaigns_submitted_by_fkey REFERENCES users (id),
  submitted_at         datetime2(3) NULL,
  approved_by          uniqueidentifier NULL CONSTRAINT campaigns_approved_by_fkey REFERENCES users (id),
  approved_at          datetime2(3) NULL,
  rejection_reason     nvarchar(500) NULL,
  cancelled_by         uniqueidentifier NULL CONSTRAINT campaigns_cancelled_by_fkey REFERENCES users (id),
  cancelled_at         datetime2(3) NULL,
  cancel_reason        nvarchar(500) NULL,
  started_at           datetime2(3) NULL,
  finished_at          datetime2(3) NULL,
  recipient_count      int NULL CHECK (recipient_count >= 0),
  reserved             int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  created_at           datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at           datetime2(3) NOT NULL DEFAULT ${NOW},
  -- Parte B: nobody approves a campaign they submitted.
  CONSTRAINT campaigns_maker_checker CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by),
  CONSTRAINT campaigns_approved_fields CHECK (
    status NOT IN ('approved', 'scheduled', 'sending', 'paused', 'completed') OR approved_by IS NOT NULL OR started_at IS NOT NULL
  ),
  CONSTRAINT campaigns_schedule_by_date CHECK (
    schedule_variable IS NULL OR (schedule_offset_days IS NOT NULL AND schedule_time IS NOT NULL)
  )
);
CREATE INDEX campaigns_area_status_idx ON campaigns (area_id, status, created_at DESC);
CREATE INDEX campaigns_due_idx ON campaigns (scheduled_at) WHERE status IN ('approved', 'scheduled');
CREATE INDEX campaigns_template_version_id_idx ON campaigns (template_version_id);
CREATE INDEX campaigns_list_id_idx ON campaigns (list_id);
CREATE INDEX campaigns_sender_id_idx ON campaigns (sender_id);
CREATE INDEX campaigns_attachment_id_idx ON campaigns (attachment_id);
CREATE INDEX campaigns_created_by_idx ON campaigns (created_by);
CREATE INDEX campaigns_updated_by_idx ON campaigns (updated_by);
CREATE INDEX campaigns_submitted_by_idx ON campaigns (submitted_by);
CREATE INDEX campaigns_approved_by_idx ON campaigns (approved_by);
CREATE INDEX campaigns_cancelled_by_idx ON campaigns (cancelled_by);
CREATE INDEX campaigns_started_at_idx ON campaigns (started_at) WHERE started_at IS NOT NULL;

CREATE TABLE campaign_recipients (
  id          uniqueidentifier NOT NULL CONSTRAINT campaign_recipients_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  campaign_id uniqueidentifier NOT NULL CONSTRAINT campaign_recipients_campaign_id_fkey REFERENCES campaigns (id),
  contact_id  uniqueidentifier NULL CONSTRAINT campaign_recipients_contact_id_fkey REFERENCES contacts (id) ON DELETE SET NULL,
  email       ${EMAIL_TYPE} NOT NULL,
  email_hash  AS ${emailHash('email')} PERSISTED,
  first_name  nvarchar(100) NULL,
  last_name   nvarchar(100) NULL,
  attributes  nvarchar(max) NOT NULL DEFAULT N'{}' CHECK (${isJson('attributes', 'OBJECT')}),
  status      varchar(10) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sending', 'sent', 'rejected', 'suppressed', 'failed', 'cancelled')),
  message_id  varchar(100) NULL,
  batch_id    uniqueidentifier NULL,
  send_at     datetime2(3) NULL,
  sent_at     datetime2(3) NULL,
  error       nvarchar(200) NULL,
  created_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  CONSTRAINT campaign_recipients_campaign_id_email_key UNIQUE (campaign_id, email)
);
CREATE INDEX campaign_recipients_pending_idx ON campaign_recipients (campaign_id, status);
CREATE INDEX campaign_recipients_contact_idx ON campaign_recipients (contact_id);
CREATE UNIQUE INDEX campaign_recipients_message_idx ON campaign_recipients (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX campaign_recipients_email_idx ON campaign_recipients (email);
CREATE INDEX campaign_recipients_email_hash_idx ON campaign_recipients (email_hash);
CREATE INDEX campaign_recipients_due_idx ON campaign_recipients (campaign_id, send_at) WHERE status = 'pending' AND batch_id IS NULL;

CREATE TABLE campaign_test_sends (
  id          uniqueidentifier NOT NULL CONSTRAINT campaign_test_sends_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  campaign_id uniqueidentifier NOT NULL CONSTRAINT campaign_test_sends_campaign_id_fkey REFERENCES campaigns (id),
  user_id     uniqueidentifier NOT NULL CONSTRAINT campaign_test_sends_user_id_fkey REFERENCES users (id),
  email       ${EMAIL_TYPE} NOT NULL,
  status      varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  message_id  varchar(100) NULL,
  error       nvarchar(200) NULL,
  created_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  sent_at     datetime2(3) NULL
);
CREATE INDEX campaign_test_sends_user_idx ON campaign_test_sends (user_id, created_at);
CREATE INDEX campaign_test_sends_campaign_idx ON campaign_test_sends (campaign_id);

ALTER TABLE quota_movements WITH NOCHECK
  ADD CONSTRAINT quota_movements_campaign_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns (id);

GRANT SELECT, INSERT, UPDATE ON campaign_attachments TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON campaign_test_sends TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns TO app_runtime;
-- Recipients of a draft are removed when it goes back to draft.
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_recipients TO app_runtime;
`;

export const down = `
ALTER TABLE quota_movements DROP CONSTRAINT quota_movements_campaign_fkey;
DROP TABLE campaign_test_sends, campaign_recipients, campaigns, campaign_attachments;
`;
