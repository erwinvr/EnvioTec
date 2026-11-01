#!/usr/bin/env bash
# Generates random secrets and a self-signed TLS certificate for development
# or for the check environment. Never use these files in production.
#
# Usage: scripts/generate-dev-secrets.sh [directory] [--force]
#   directory  default: ./secrets
#   --force    overwrite existing secrets (then run `docker compose down -v`:
#              PostgreSQL only reads the role passwords when its volume is new)
set -euo pipefail

cd "$(dirname "$0")/.."
dir="./secrets"
force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -*) echo "Opción desconocida: $arg" >&2; exit 1 ;;
    *) dir="$arg" ;;
  esac
done

if [[ -d "$dir" && -n "$(ls -A "$dir" 2>/dev/null)" && "$force" -ne 1 ]]; then
  echo "Ya existen secretos en $dir. Use --force para regenerarlos." >&2
  exit 1
fi

command -v openssl >/dev/null || { echo "Se requiere openssl." >&2; exit 1; }

rm -rf "$dir"
mkdir -p "$dir"
# The directory protects the secrets from other host users. The files must be
# readable by the non-root users inside the containers, because Compose file
# secrets (outside Swarm) keep the host permissions.
chmod 700 "$dir"

write() {
  printf '%s' "$2" > "$dir/$1"
  chmod 644 "$dir/$1"
}
hex() { openssl rand -hex 32; }

postgres_password=$(hex)
owner_password=$(hex)
runtime_password=$(hex)
redis_backend_password=$(hex)
redis_worker_password=$(hex)
redis_files_password=$(hex)

write postgres_password "$postgres_password"
write db_owner_password "$owner_password"
write db_runtime_password "$runtime_password"
write database_url "postgres://app_runtime:${runtime_password}@postgres:5432/enviotec"
write migration_database_url "postgres://app_owner:${owner_password}@postgres:5432/enviotec"
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

echo "Secretos de desarrollo generados en $dir"
