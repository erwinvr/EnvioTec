#!/usr/bin/env bash
# Generates random secrets and self-signed TLS material for development or
# for the check environment. Never use these files in production (see
# docs/deployment.md).
#
# Usage: scripts/generate-dev-secrets.sh [directory] [--force] [--with-sqlserver]
#   directory         default: ./secrets
#   --force           overwrite existing secrets
#   --with-sqlserver  also the SQL Server container of the check environment:
#                     its sa password, the admin URL and a CA plus a server
#                     certificate for "sqlserver", so TLS is validated as in
#                     production
# Database (ADR-032), from the environment:
#   DB_HOST (default sqlserver), DB_PORT (1433), DB_NAME (enviotec)
# The owner and runtime logins are <DB_NAME>_owner and <DB_NAME>_runtime.
# Provisioning creates them on the server (npm run db:provision).
set -euo pipefail

cd "$(dirname "$0")/.."
dir="./secrets"
force=0
sqlserver=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --with-sqlserver) sqlserver=1 ;;
    -*) echo "Opción desconocida: $arg" >&2; exit 1 ;;
    *) dir="$arg" ;;
  esac
done

db_host="${DB_HOST:-sqlserver}"
db_port="${DB_PORT:-1433}"
db_name="${DB_NAME:-enviotec}"
if ! [[ "$db_name" =~ ^[A-Za-z_][A-Za-z0-9_]{0,40}$ ]]; then
  echo "DB_NAME inválido: $db_name" >&2
  exit 1
fi

if [[ -d "$dir" && -n "$(ls -A "$dir" 2>/dev/null)" && "$force" -ne 1 ]]; then
  echo "Ya existen secretos en $dir. Use --force para regenerarlos." >&2
  exit 1
fi

command -v openssl >/dev/null || { echo "Se requiere openssl." >&2; exit 1; }

# --force keeps what this script cannot generate: the Mandrill keys and the
# administrative URL of an external SQL Server.
keep=$(mktemp -d)
trap 'rm -rf "$keep"' EXIT
for name in mandrill_campaigns_api_key mandrill_system_api_key database_admin_url; do
  if [[ -f "$dir/$name" && "$sqlserver" -eq 0 ]]; then cp -p "$dir/$name" "$keep/"; fi
done

rm -rf "$dir"
mkdir -p "$dir"
# The directory protects the secrets from other host users. The files must be
# readable by the non-root users inside the containers, because Compose file
# secrets (outside Swarm) keep the host permissions.
chmod 700 "$dir"
cp -p "$keep"/* "$dir"/ 2>/dev/null || true

write() {
  printf '%s' "$2" > "$dir/$1"
  chmod 644 "$dir/$1"
}
hex() { openssl rand -hex 32; }
# SQL Server password policy: upper and lower case and digits; letters and
# digits only, so the value needs no escaping inside the connection URL.
sqlpw() { printf '%sAa1' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 36)"; }

owner_password=$(sqlpw)
runtime_password=$(sqlpw)
redis_backend_password=$(hex)
redis_worker_password=$(hex)
redis_files_password=$(hex)

write migration_database_url "sqlserver://${db_name}_owner:${owner_password}@${db_host}:${db_port}/${db_name}"
write database_url "sqlserver://${db_name}_runtime:${runtime_password}@${db_host}:${db_port}/${db_name}"
write redis_backend_password "$redis_backend_password"
write redis_worker_password "$redis_worker_password"
write redis_url_backend "redis://backend:${redis_backend_password}@redis:6379/0"
write redis_url_worker "redis://worker:${redis_worker_password}@redis:6379/0"
write redis_files_password "$redis_files_password"
write redis_url_files "redis://files:${redis_files_password}@redis:6379/0"
write csrf_secret "$(openssl rand -base64 48 | tr -d '\n')"
write data_encryption_key "$(openssl rand -base64 32 | tr -d '\n')"

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:nginx,IP:127.0.0.1" \
  -keyout "$dir/tls_key" -out "$dir/tls_cert" 2>/dev/null
chmod 644 "$dir/tls_key" "$dir/tls_cert"

if [[ "$sqlserver" -eq 1 ]]; then
  sa_password=$(sqlpw)
  write database_admin_password "$sa_password"
  write database_admin_url "sqlserver://sa:${sa_password}@${db_host}:${db_port}/master"
  # A throwaway CA and the certificate of the "sqlserver" container (RSA, as
  # SQL Server on Linux requires).
  work=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=EnvioTec check CA" \
    -keyout "$work/ca.key" -out "$dir/database_ca_cert" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=${db_host}" -keyout "$dir/sqlserver_tls_key" -out "$work/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$db_host" > "$work/ext"
  openssl x509 -req -in "$work/server.csr" -CA "$dir/database_ca_cert" -CAkey "$work/ca.key" -CAcreateserial \
    -days 30 -extfile "$work/ext" -out "$dir/sqlserver_tls_cert" 2>/dev/null
  rm -rf "$work"
  chmod 644 "$dir/database_ca_cert" "$dir/sqlserver_tls_key" "$dir/sqlserver_tls_cert"
fi

echo "Secretos de desarrollo generados en $dir"
