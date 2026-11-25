#!/usr/bin/env bash
# Creates or brings up to date the EnvioTec database and its least-privilege
# logins on SQL Server (ADR-032). Runs once per environment, from the host:
#   npm run db:provision [-- --reset-passwords]
# Needs, in SECRETS_DIR (default ./secrets):
#   database_admin_url      sqlserver://<admin login>:<password>@<host>:1433/master
#                           (an administrative login; the application never uses it)
#   migration_database_url  owner login and database
#   database_url            runtime login (same server and database)
# The administrative URL is mounted only for this run. Remove the file
# afterwards if the environment does not need to provision again.
# For production, use the production files:
#   COMPOSE_FILE=docker-compose.yml npm run db:provision
set -euo pipefail

cd "$(dirname "$0")/.."
secrets="${SECRETS_DIR:-./secrets}"
for name in database_admin_url migration_database_url database_url; do
  [[ -f "$secrets/$name" ]] || { echo "Falta $secrets/$name" >&2; exit 1; }
done

docker compose run --rm -T \
  -v "$(realpath "$secrets/database_admin_url"):/run/provision/database_admin_url:ro" \
  -v "$(realpath "$secrets/database_url"):/run/provision/database_url:ro" \
  -e DATABASE_ADMIN_URL_FILE=/run/provision/database_admin_url \
  -e DATABASE_URL_FILE=/run/provision/database_url \
  tools node scripts/provision.js "$@"
