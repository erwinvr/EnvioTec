// Core identity model (A4, ADR-006, ADR-007, ADR-008): areas, users, roles,
// permissions and their assignments, with the database-level guards that do
// not depend on the application.

export const up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS citext;

    CREATE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;

    CREATE TABLE areas (
      id            uuid PRIMARY KEY DEFAULT uuidv7(),
      name          citext NOT NULL UNIQUE CHECK (length(name) BETWEEN 2 AND 100),
      ad_department citext UNIQUE CHECK (ad_department IS NULL OR length(ad_department) BETWEEN 1 AND 200),
      is_active     boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid,
      updated_by    uuid
    );

    CREATE TABLE users (
      id                   uuid PRIMARY KEY DEFAULT uuidv7(),
      username             citext NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9._-]{3,64}$'),
      email                citext NOT NULL UNIQUE CHECK (length(email) <= 254 AND email ~ '^[^@\\s]+@[^@\\s]+$'),
      display_name         text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
      auth_source          text NOT NULL CHECK (auth_source IN ('local', 'ad')),
      password_hash        text,
      ad_object_guid       uuid UNIQUE,
      area_id              uuid REFERENCES areas (id) ON DELETE RESTRICT,
      status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'locked')),
      must_change_password boolean NOT NULL DEFAULT false,
      password_changed_at  timestamptz,
      failed_login_count   integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
      locked_until         timestamptz,
      mfa_secret_encrypted bytea,
      mfa_enabled_at       timestamptz,
      expires_at           timestamptz,
      exempt_from_expiry   boolean NOT NULL DEFAULT false,
      is_emergency         boolean NOT NULL DEFAULT false,
      last_login_at        timestamptz,
      deleted_at           timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      created_by           uuid REFERENCES users (id) ON DELETE RESTRICT,
      updated_by           uuid REFERENCES users (id) ON DELETE RESTRICT,
      -- A single authentication origin per account (Parte B).
      CONSTRAINT users_auth_source_fields CHECK (
        (auth_source = 'local' AND password_hash IS NOT NULL AND ad_object_guid IS NULL AND area_id IS NOT NULL)
        OR (auth_source = 'ad' AND password_hash IS NULL AND ad_object_guid IS NOT NULL)
      ),
      -- Local accounts expire unless explicitly exempt; AD accounts never do.
      CONSTRAINT users_local_expiry CHECK (
        (auth_source = 'local' AND (exempt_from_expiry OR expires_at IS NOT NULL))
        OR (auth_source = 'ad' AND expires_at IS NULL AND NOT exempt_from_expiry)
      ),
      CONSTRAINT users_emergency_is_local CHECK (NOT is_emergency OR auth_source = 'local'),
      CONSTRAINT users_mfa_fields CHECK ((mfa_enabled_at IS NULL) = (mfa_secret_encrypted IS NULL))
    );
    CREATE INDEX users_area_id_idx ON users (area_id);
    CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
    CREATE INDEX users_auth_source_idx ON users (auth_source) WHERE deleted_at IS NULL;
    CREATE INDEX users_created_by_idx ON users (created_by);
    CREATE INDEX users_updated_by_idx ON users (updated_by);
    CREATE INDEX users_expires_at_idx ON users (expires_at) WHERE auth_source = 'local' AND deleted_at IS NULL;

    ALTER TABLE areas
      ADD CONSTRAINT areas_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
      ADD CONSTRAINT areas_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT;
    CREATE INDEX areas_created_by_idx ON areas (created_by);
    CREATE INDEX areas_updated_by_idx ON areas (updated_by);

    CREATE TABLE roles (
      id          uuid PRIMARY KEY DEFAULT uuidv7(),
      name        citext NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_-]{1,49}$'),
      description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
      is_system   boolean NOT NULL DEFAULT false,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
      updated_by  uuid REFERENCES users (id) ON DELETE RESTRICT
    );
    CREATE INDEX roles_created_by_idx ON roles (created_by);
    CREATE INDEX roles_updated_by_idx ON roles (updated_by);

    -- Loaded only by seeds and migrations, never from the UI (A4).
    CREATE TABLE permissions (
      id                uuid PRIMARY KEY DEFAULT uuidv7(),
      code              text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z_]*\\.[a-z][a-z_]*$'),
      description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
      is_administrative boolean NOT NULL DEFAULT false,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_roles (
      user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      role_id     uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
      source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ad_group')),
      assigned_by uuid REFERENCES users (id) ON DELETE RESTRICT,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_id)
    );
    CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);
    CREATE INDEX user_roles_assigned_by_idx ON user_roles (assigned_by);

    CREATE TABLE role_permissions (
      role_id       uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
      permission_id uuid NOT NULL REFERENCES permissions (id) ON DELETE RESTRICT,
      granted_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
      granted_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (role_id, permission_id)
    );
    CREATE INDEX role_permissions_permission_id_idx ON role_permissions (permission_id);
    CREATE INDEX role_permissions_granted_by_idx ON role_permissions (granted_by);

    CREATE TABLE ad_group_role_mappings (
      id         uuid PRIMARY KEY DEFAULT uuidv7(),
      group_dn   citext NOT NULL UNIQUE CHECK (length(group_dn) BETWEEN 3 AND 500),
      role_id    uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid REFERENCES users (id) ON DELETE RESTRICT,
      updated_by uuid REFERENCES users (id) ON DELETE RESTRICT
    );
    CREATE INDEX ad_group_role_mappings_role_id_idx ON ad_group_role_mappings (role_id);
    CREATE INDEX ad_group_role_mappings_created_by_idx ON ad_group_role_mappings (created_by);
    CREATE INDEX ad_group_role_mappings_updated_by_idx ON ad_group_role_mappings (updated_by);

    CREATE TRIGGER areas_updated_at BEFORE UPDATE ON areas FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER permissions_updated_at BEFORE UPDATE ON permissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER ad_group_role_mappings_updated_at BEFORE UPDATE ON ad_group_role_mappings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- A role is administrative when it holds at least one administrative permission.
    CREATE FUNCTION role_is_administrative(target_role uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = target_role AND p.is_administrative
      );
    $$;

    -- ADR-007: administrative roles only for local accounts and never from AD groups.
    CREATE FUNCTION guard_user_roles() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF role_is_administrative(NEW.role_id) THEN
        IF NEW.source = 'ad_group' THEN
          RAISE EXCEPTION 'administrative roles cannot come from AD groups' USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND auth_source = 'ad') THEN
          RAISE EXCEPTION 'administrative roles can only be assigned to local accounts' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER user_roles_guard BEFORE INSERT OR UPDATE ON user_roles
      FOR EACH ROW EXECUTE FUNCTION guard_user_roles();

    CREATE FUNCTION guard_role_permissions() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        IF EXISTS (SELECT 1 FROM permissions WHERE id = NEW.permission_id AND is_administrative) AND (
          EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
                  WHERE ur.role_id = NEW.role_id AND (u.auth_source = 'ad' OR ur.source = 'ad_group'))
          OR EXISTS (SELECT 1 FROM ad_group_role_mappings WHERE role_id = NEW.role_id)
        ) THEN
          RAISE EXCEPTION 'administrative permissions cannot be added to a role held by AD accounts or mapped from AD'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END IF;
      -- DELETE: system roles never lose permissions (A6, rule 4).
      IF EXISTS (SELECT 1 FROM roles WHERE id = OLD.role_id AND is_system) THEN
        RAISE EXCEPTION 'permissions of a system role cannot be removed' USING ERRCODE = 'check_violation';
      END IF;
      RETURN OLD;
    END;
    $$;
    CREATE TRIGGER role_permissions_guard BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
      FOR EACH ROW EXECUTE FUNCTION guard_role_permissions();

    CREATE FUNCTION guard_ad_group_role_mappings() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF role_is_administrative(NEW.role_id) THEN
        RAISE EXCEPTION 'AD groups cannot be mapped to administrative roles' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ad_group_role_mappings_guard BEFORE INSERT OR UPDATE ON ad_group_role_mappings
      FOR EACH ROW EXECUTE FUNCTION guard_ad_group_role_mappings();

    -- A6, rule 4: system roles are neither deleted nor renamed.
    CREATE FUNCTION guard_system_roles() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.is_system AND (TG_OP = 'DELETE' OR NEW.name <> OLD.name OR NOT NEW.is_system) THEN
        RAISE EXCEPTION 'system roles cannot be deleted, renamed or demoted' USING ERRCODE = 'check_violation';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$;
    CREATE TRIGGER roles_system_guard BEFORE UPDATE OR DELETE ON roles
      FOR EACH ROW EXECUTE FUNCTION guard_system_roles();

    -- The authentication origin of an account never changes (Parte B).
    CREATE FUNCTION guard_user_auth_source() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.auth_source <> OLD.auth_source THEN
        RAISE EXCEPTION 'the authentication source of an account cannot change' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER users_auth_source_guard BEFORE UPDATE OF auth_source ON users
      FOR EACH ROW EXECUTE FUNCTION guard_user_auth_source();

    GRANT SELECT, INSERT, UPDATE, DELETE ON areas, users, roles, user_roles, role_permissions, ad_group_role_mappings
      TO app_runtime;
    GRANT SELECT ON permissions TO app_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE ad_group_role_mappings, role_permissions, user_roles, permissions, roles;
    ALTER TABLE areas DROP CONSTRAINT areas_created_by_fkey, DROP CONSTRAINT areas_updated_by_fkey;
    DROP TABLE users, areas;
    DROP FUNCTION guard_user_auth_source(), guard_system_roles(), guard_ad_group_role_mappings(),
      guard_role_permissions(), guard_user_roles(), role_is_administrative(uuid), set_updated_at();
    DROP EXTENSION IF EXISTS citext;
  `);
};
