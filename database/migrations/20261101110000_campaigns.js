// Phase 8.4: campaigns (Parte B, ADR-011).
// - campaigns: template version + list + PDF + sender + schedule, of one
//   area; the approver is never who submitted it (CHECK).
// - campaign_attachments: the single PDF, inspected in the file-processor;
//   its SHA-256 proves which file was sent.
// - campaign_recipients: snapshot taken at approval (suppression applied);
//   one row per recipient, which the sender (8.5) moves through its states.
// - campaign_test_sends: test sends, at most N per user per day.

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE campaign_attachments (
      id             uuid PRIMARY KEY DEFAULT uuidv7(),
      area_id        uuid NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
      file_id        uuid NOT NULL UNIQUE,
      original_name  text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
      size_bytes     integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
      sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
      failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 100),
      created_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      created_at     timestamptz NOT NULL DEFAULT now(),
      processed_at   timestamptz
    );
    CREATE INDEX campaign_attachments_area_id_idx ON campaign_attachments (area_id);
    CREATE INDEX campaign_attachments_created_by_idx ON campaign_attachments (created_by);

    CREATE TABLE campaigns (
      id                  uuid PRIMARY KEY DEFAULT uuidv7(),
      area_id             uuid NOT NULL REFERENCES areas (id) ON DELETE RESTRICT,
      name                text NOT NULL CHECK (length(name) BETWEEN 2 AND 150),
      status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'submitted', 'approved', 'scheduled', 'sending', 'paused', 'completed', 'cancelled')),
      subject             text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200 AND subject !~ '[\\r\\n]'),
      template_version_id uuid NOT NULL REFERENCES template_versions (id) ON DELETE RESTRICT,
      list_id             uuid NOT NULL REFERENCES contact_lists (id) ON DELETE RESTRICT,
      sender_id           uuid NOT NULL REFERENCES sender_identities (id) ON DELETE RESTRICT,
      attachment_id       uuid REFERENCES campaign_attachments (id) ON DELETE RESTRICT,
      scheduled_at        timestamptz,
      created_by          uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      updated_by          uuid REFERENCES users (id) ON DELETE RESTRICT,
      submitted_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
      submitted_at        timestamptz,
      approved_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
      approved_at         timestamptz,
      rejection_reason    text CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 500),
      cancelled_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
      cancelled_at        timestamptz,
      cancel_reason       text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
      started_at          timestamptz,
      finished_at         timestamptz,
      recipient_count     integer CHECK (recipient_count >= 0),
      reserved            integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      -- Parte B: nobody approves a campaign they submitted.
      CONSTRAINT campaigns_maker_checker CHECK (approved_by IS NULL OR approved_by <> submitted_by),
      CONSTRAINT campaigns_approved_fields CHECK (
        status NOT IN ('approved', 'scheduled', 'sending', 'paused', 'completed')
        OR (approved_by IS NOT NULL OR started_at IS NOT NULL)
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
    CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE campaign_recipients (
      id          uuid PRIMARY KEY DEFAULT uuidv7(),
      campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
      contact_id  uuid REFERENCES contacts (id) ON DELETE SET NULL,
      email       citext NOT NULL,
      first_name  text,
      last_name   text,
      attributes  jsonb NOT NULL DEFAULT '{}',
      status      text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'rejected', 'suppressed', 'failed', 'cancelled')),
      message_id  text CHECK (message_id IS NULL OR length(message_id) <= 100),
      batch_id    uuid,
      sent_at     timestamptz,
      error       text CHECK (error IS NULL OR length(error) <= 200),
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (campaign_id, email)
    );
    CREATE INDEX campaign_recipients_pending_idx ON campaign_recipients (campaign_id, status);
    CREATE INDEX campaign_recipients_contact_idx ON campaign_recipients (contact_id);
    CREATE UNIQUE INDEX campaign_recipients_message_idx ON campaign_recipients (message_id) WHERE message_id IS NOT NULL;

    CREATE TABLE campaign_test_sends (
      id          uuid PRIMARY KEY DEFAULT uuidv7(),
      campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE RESTRICT,
      user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      email       citext NOT NULL CHECK (length(email) <= 254),
      status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      message_id  text,
      error       text CHECK (error IS NULL OR length(error) <= 200),
      created_at  timestamptz NOT NULL DEFAULT now(),
      sent_at     timestamptz
    );
    CREATE INDEX campaign_test_sends_user_idx ON campaign_test_sends (user_id, created_at);
    CREATE INDEX campaign_test_sends_campaign_idx ON campaign_test_sends (campaign_id);

    ALTER TABLE quota_movements
      ADD CONSTRAINT quota_movements_campaign_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE RESTRICT NOT VALID;

    GRANT SELECT, INSERT, UPDATE ON campaign_attachments, campaign_recipients, campaign_test_sends TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns TO app_runtime;
    -- Recipients of a draft are removed when it goes back to draft.
    GRANT DELETE ON campaign_recipients TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE quota_movements DROP CONSTRAINT quota_movements_campaign_fkey;
    DROP TABLE campaign_test_sends, campaign_recipients, campaigns, campaign_attachments;
  `);
};
