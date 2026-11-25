import { BIN, EMAIL_TYPE, NOW, dottedCode, emailCheck, only } from '../scripts/lib/sql-checks.js';

// Core identity model (A4, ADR-006, ADR-007, ADR-008, ADR-032): areas, users,
// roles, permissions and their assignments, with the database-level guards
// that do not depend on the application. Runtime privileges go to the
// database role app_runtime (created by scripts/provision.js).
// updated_at is set by each UPDATE statement: a table with triggers cannot
// use OUTPUT without INTO, so only the guard triggers remain.

export const up = `
CREATE TABLE areas (
  id            uniqueidentifier NOT NULL CONSTRAINT areas_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  name          nvarchar(100) NOT NULL CONSTRAINT areas_name_key UNIQUE CHECK (LEN(name) BETWEEN 2 AND 100),
  ad_department nvarchar(200) NULL CHECK (ad_department IS NULL OR LEN(ad_department) BETWEEN 1 AND 200),
  is_active     bit NOT NULL DEFAULT 1,
  created_at    datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at    datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by    uniqueidentifier NULL,
  updated_by    uniqueidentifier NULL
);
CREATE UNIQUE INDEX areas_ad_department_key ON areas (ad_department) WHERE ad_department IS NOT NULL;

CREATE TABLE users (
  id                     uniqueidentifier NOT NULL CONSTRAINT users_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  username               nvarchar(64) NOT NULL CONSTRAINT users_username_key UNIQUE CHECK (${only('username', 'A-Za-z0-9._-', 3, 64)}),
  email                  ${EMAIL_TYPE} NOT NULL CONSTRAINT users_email_key UNIQUE CHECK (${emailCheck('email', { dot: false })}),
  display_name           nvarchar(200) NOT NULL CHECK (LEN(display_name) BETWEEN 1 AND 200),
  auth_source            varchar(5) NOT NULL CHECK (auth_source IN ('local', 'ad')),
  password_hash          nvarchar(300) NULL,
  ad_object_guid         uniqueidentifier NULL,
  area_id                uniqueidentifier NULL CONSTRAINT users_area_id_fkey REFERENCES areas (id),
  status                 varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'locked')),
  must_change_password   bit NOT NULL DEFAULT 0,
  password_changed_at    datetime2(3) NULL,
  failed_login_count     int NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  last_failed_login_at   datetime2(3) NULL,
  locked_until           datetime2(3) NULL,
  mfa_secret_encrypted   varbinary(512) NULL,
  mfa_enabled_at         datetime2(3) NULL,
  mfa_last_used_step     bigint NULL CHECK (mfa_last_used_step >= 0),
  expires_at             datetime2(3) NULL,
  exempt_from_expiry     bit NOT NULL DEFAULT 0,
  is_emergency           bit NOT NULL DEFAULT 0,
  last_login_at          datetime2(3) NULL,
  disabled_reason        varchar(10) NULL CHECK (disabled_reason IN ('manual', 'expired', 'inactive')),
  disabled_at            datetime2(3) NULL,
  expiry_warning_sent_at datetime2(3) NULL,
  activity_reset_at      datetime2(3) NULL,
  deleted_at             datetime2(3) NULL,
  created_at             datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at             datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by             uniqueidentifier NULL CONSTRAINT users_created_by_fkey REFERENCES users (id),
  updated_by             uniqueidentifier NULL CONSTRAINT users_updated_by_fkey REFERENCES users (id),
  -- A single authentication origin per account (Parte B).
  CONSTRAINT users_auth_source_fields CHECK (
    (auth_source = 'local' AND password_hash IS NOT NULL AND ad_object_guid IS NULL AND area_id IS NOT NULL)
    OR (auth_source = 'ad' AND password_hash IS NULL AND ad_object_guid IS NOT NULL)
  ),
  -- Local accounts expire unless explicitly exempt; AD accounts never do.
  CONSTRAINT users_local_expiry CHECK (
    (auth_source = 'local' AND (exempt_from_expiry = 1 OR expires_at IS NOT NULL))
    OR (auth_source = 'ad' AND expires_at IS NULL AND exempt_from_expiry = 0)
  ),
  CONSTRAINT users_emergency_is_local CHECK (is_emergency = 0 OR auth_source = 'local'),
  CONSTRAINT users_mfa_fields CHECK (
    (mfa_enabled_at IS NULL AND mfa_secret_encrypted IS NULL) OR (mfa_enabled_at IS NOT NULL AND mfa_secret_encrypted IS NOT NULL)
  ),
  CONSTRAINT users_disabled_fields CHECK (
    ((disabled_reason IS NULL AND disabled_at IS NULL) OR (disabled_reason IS NOT NULL AND disabled_at IS NOT NULL))
    AND (disabled_reason IS NULL OR status = 'disabled')
  )
);
CREATE UNIQUE INDEX users_ad_object_guid_key ON users (ad_object_guid) WHERE ad_object_guid IS NOT NULL;
CREATE INDEX users_area_id_idx ON users (area_id);
CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX users_auth_source_idx ON users (auth_source) WHERE deleted_at IS NULL;
CREATE INDEX users_created_by_idx ON users (created_by);
CREATE INDEX users_updated_by_idx ON users (updated_by);
CREATE INDEX users_expires_at_idx ON users (expires_at) WHERE auth_source = 'local' AND deleted_at IS NULL;
CREATE INDEX users_last_login_at_idx ON users (last_login_at) WHERE auth_source = 'local' AND deleted_at IS NULL;

ALTER TABLE areas ADD
  CONSTRAINT areas_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT areas_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id);
CREATE INDEX areas_created_by_idx ON areas (created_by);
CREATE INDEX areas_updated_by_idx ON areas (updated_by);

CREATE TABLE roles (
  id          uniqueidentifier NOT NULL CONSTRAINT roles_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  name        nvarchar(50) NOT NULL CONSTRAINT roles_name_key UNIQUE
                CHECK (${only('name', 'a-z0-9_-', 2, 50)} AND name ${BIN} LIKE '[a-z]%'),
  description nvarchar(500) NOT NULL DEFAULT N'',
  is_system   bit NOT NULL DEFAULT 0,
  created_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at  datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by  uniqueidentifier NULL CONSTRAINT roles_created_by_fkey REFERENCES users (id),
  updated_by  uniqueidentifier NULL CONSTRAINT roles_updated_by_fkey REFERENCES users (id)
);
CREATE INDEX roles_created_by_idx ON roles (created_by);
CREATE INDEX roles_updated_by_idx ON roles (updated_by);

-- Loaded only by seeds and migrations, never from the UI (A4).
CREATE TABLE permissions (
  id                uniqueidentifier NOT NULL CONSTRAINT permissions_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  code              varchar(100) NOT NULL CONSTRAINT permissions_code_key UNIQUE CHECK (${dottedCode('code', { maxDots: 1 })}),
  description       nvarchar(300) NOT NULL CHECK (LEN(description) BETWEEN 1 AND 300),
  is_administrative bit NOT NULL DEFAULT 0,
  created_at        datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at        datetime2(3) NOT NULL DEFAULT ${NOW}
);

CREATE TABLE user_roles (
  user_id     uniqueidentifier NOT NULL CONSTRAINT user_roles_user_id_fkey REFERENCES users (id),
  role_id     uniqueidentifier NOT NULL CONSTRAINT user_roles_role_id_fkey REFERENCES roles (id),
  source      varchar(10) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ad_group')),
  assigned_by uniqueidentifier NULL CONSTRAINT user_roles_assigned_by_fkey REFERENCES users (id),
  assigned_at datetime2(3) NOT NULL DEFAULT ${NOW},
  CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);
CREATE INDEX user_roles_assigned_by_idx ON user_roles (assigned_by);

CREATE TABLE role_permissions (
  role_id       uniqueidentifier NOT NULL CONSTRAINT role_permissions_role_id_fkey REFERENCES roles (id),
  permission_id uniqueidentifier NOT NULL CONSTRAINT role_permissions_permission_id_fkey REFERENCES permissions (id),
  granted_by    uniqueidentifier NULL CONSTRAINT role_permissions_granted_by_fkey REFERENCES users (id),
  granted_at    datetime2(3) NOT NULL DEFAULT ${NOW},
  CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX role_permissions_permission_id_idx ON role_permissions (permission_id);
CREATE INDEX role_permissions_granted_by_idx ON role_permissions (granted_by);

CREATE TABLE ad_group_role_mappings (
  id         uniqueidentifier NOT NULL CONSTRAINT ad_group_role_mappings_pkey PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
  group_dn   nvarchar(500) NOT NULL CONSTRAINT ad_group_role_mappings_group_dn_key UNIQUE CHECK (LEN(group_dn) BETWEEN 3 AND 500),
  role_id    uniqueidentifier NOT NULL CONSTRAINT ad_group_role_mappings_role_id_fkey REFERENCES roles (id),
  created_at datetime2(3) NOT NULL DEFAULT ${NOW},
  updated_at datetime2(3) NOT NULL DEFAULT ${NOW},
  created_by uniqueidentifier NULL CONSTRAINT ad_group_role_mappings_created_by_fkey REFERENCES users (id),
  updated_by uniqueidentifier NULL CONSTRAINT ad_group_role_mappings_updated_by_fkey REFERENCES users (id)
);
CREATE INDEX ad_group_role_mappings_role_id_idx ON ad_group_role_mappings (role_id);
CREATE INDEX ad_group_role_mappings_created_by_idx ON ad_group_role_mappings (created_by);
CREATE INDEX ad_group_role_mappings_updated_by_idx ON ad_group_role_mappings (updated_by);
GO

-- A role is administrative when it holds at least one administrative permission.
CREATE FUNCTION dbo.role_is_administrative (@role_id uniqueidentifier) RETURNS bit
AS
BEGIN
  RETURN CASE WHEN EXISTS (
    SELECT 1 FROM dbo.role_permissions rp JOIN dbo.permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = @role_id AND p.is_administrative = 1
  ) THEN 1 ELSE 0 END;
END
GO

-- ADR-007: administrative roles only for local accounts and never from AD groups.
CREATE TRIGGER user_roles_guard ON user_roles AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (
    SELECT 1 FROM inserted i
     WHERE dbo.role_is_administrative(i.role_id) = 1
       AND (i.source = 'ad_group' OR EXISTS (SELECT 1 FROM users u WHERE u.id = i.user_id AND u.auth_source = 'ad'))
  )
    THROW 51000, 'administrative roles can only be assigned to local accounts and never from AD groups', 1;
END
GO

CREATE TRIGGER role_permissions_guard ON role_permissions AFTER INSERT, UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (
    SELECT 1 FROM inserted i JOIN permissions p ON p.id = i.permission_id AND p.is_administrative = 1
     WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
                    WHERE ur.role_id = i.role_id AND (u.auth_source = 'ad' OR ur.source = 'ad_group'))
        OR EXISTS (SELECT 1 FROM ad_group_role_mappings m WHERE m.role_id = i.role_id)
  )
    THROW 51000, 'administrative permissions cannot be added to a role held by AD accounts or mapped from AD', 1;
  -- System roles never lose permissions (A6, rule 4).
  IF NOT EXISTS (SELECT 1 FROM inserted)
     AND EXISTS (SELECT 1 FROM deleted d JOIN roles r ON r.id = d.role_id WHERE r.is_system = 1)
    THROW 51000, 'permissions of a system role cannot be removed', 1;
END
GO

CREATE TRIGGER ad_group_role_mappings_guard ON ad_group_role_mappings AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM inserted i WHERE dbo.role_is_administrative(i.role_id) = 1)
    THROW 51000, 'AD groups cannot be mapped to administrative roles', 1;
END
GO

-- A6, rule 4: system roles are neither deleted, renamed nor demoted.
CREATE TRIGGER roles_system_guard ON roles AFTER UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (
    SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.id = d.id
     WHERE d.is_system = 1 AND (i.id IS NULL OR i.name <> d.name OR i.is_system = 0)
  )
    THROW 51000, 'system roles cannot be deleted, renamed or demoted', 1;
END
GO

-- The authentication origin of an account never changes (Parte B).
CREATE TRIGGER users_auth_source_guard ON users AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF UPDATE(auth_source) AND EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.id = i.id WHERE i.auth_source <> d.auth_source)
    THROW 51000, 'the authentication source of an account cannot change', 1;
END
GO

GRANT SELECT, INSERT, UPDATE, DELETE ON areas TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ad_group_role_mappings TO app_runtime;
GRANT SELECT ON permissions TO app_runtime;
GRANT EXECUTE ON dbo.role_is_administrative TO app_runtime;
`;

export const down = `
DROP TRIGGER users_auth_source_guard;
DROP TABLE ad_group_role_mappings, role_permissions, user_roles, permissions, roles;
ALTER TABLE areas DROP CONSTRAINT areas_created_by_fkey, areas_updated_by_fkey;
DROP TABLE users, areas;
GO
DROP FUNCTION dbo.role_is_administrative;
`;
