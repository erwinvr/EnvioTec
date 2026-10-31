#!/bin/sh
# Runs once, when the PostgreSQL volume is initialized. Creates the database
# roles (A4) with passwords from Docker secrets. Table privileges are granted
# by the migrations in phase 2.
set -eu

owner_password=$(cat /run/secrets/db_owner_password)
runtime_password=$(cat /run/secrets/db_runtime_password)

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$owner_password" \
  -v runtime_password="$runtime_password" \
  -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE app_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;

ALTER DATABASE :"db" OWNER TO app_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO app_owner, app_runtime;

ALTER SCHEMA public OWNER TO app_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_runtime;

ALTER ROLE app_runtime SET statement_timeout = '10s';
ALTER ROLE app_runtime SET idle_in_transaction_session_timeout = '30s';
SQL
