// Details of opens and clicks from Mandrill (ADR-029): time is occurred_at;
// IP, location and user agent as reported, plus device, operating system
// and mail client derived from the user agent. IP and location are personal
// data: only users with contacts.view see them in the reports.

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE message_events
      ADD COLUMN ip         inet,
      ADD COLUMN location   text CHECK (location IS NULL OR length(location) <= 200),
      ADD COLUMN user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 500),
      ADD COLUMN device     text CHECK (device IS NULL OR length(device) <= 30),
      ADD COLUMN os         text CHECK (os IS NULL OR length(os) <= 50),
      ADD COLUMN client     text CHECK (client IS NULL OR length(client) <= 50);
    -- The sync fills the details of events stored before this migration.
    GRANT UPDATE (ip, location, user_agent, device, os, client) ON message_events TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    REVOKE UPDATE (ip, location, user_agent, device, os, client) ON message_events FROM app_runtime;
    ALTER TABLE message_events DROP COLUMN ip, DROP COLUMN location, DROP COLUMN user_agent,
      DROP COLUMN device, DROP COLUMN os, DROP COLUMN client;
  `);
};
