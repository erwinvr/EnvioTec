#!/usr/bin/env bash
# Quality and security checks (A11). Same command locally and in Jenkins:
#   npm run check
# Requires Node.js (lint and audit on the host) and Docker (everything else).
# Fails on the first step that does not pass.
set -euo pipefail

cd "$(dirname "$0")/.."

# One run at a time: two runs would share the project name and the
# ephemeral secrets, and break each other.
exec 9>"${TMPDIR:-/tmp}/enviotec-check.lock"
flock -n 9 || { echo "Ya hay un npm run check en curso." >&2; exit 1; }

GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
TRIVY_IMAGE="aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c"
SCANNED_IMAGES=(enviotec/backend:local enviotec/file-processor:local enviotec/nginx:local enviotec/egress-proxy:local enviotec/tools:local)

# Separate project, secrets and subnets, so the check never touches a running
# development stack.
export COMPOSE_PROJECT_NAME=enviotec-check
export SECRETS_DIR=./.check-secrets
export EDGE_SUBNET=172.31.110.0/24
export NGINX_IP=172.31.110.10
# The browser check opens the app at https://nginx:8443, so that is the
# origin the backend accepts in this environment (CSRF Origin check).
export APP_ORIGIN=https://nginx:8443
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.check.yml)

cleanup() {
  "${COMPOSE[@]}" --profile check down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$SECRETS_DIR"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$1"; }

step "1/12 npm ci"
npm ci --no-audit --no-fund

step "2/12 Lint y tests del frontend"
npm run lint
npm run test:frontend

step "3/12 Secretos efímeros para el entorno de verificación"
bash scripts/generate-dev-secrets.sh "$SECRETS_DIR" --force

step "4/12 Construcción de imágenes y arranque del stack"
"${COMPOSE[@]}" --profile check build
docker volume create enviotec-clamav-db >/dev/null
# The first run downloads the ClamAV signatures through the egress proxy.
"${COMPOSE[@]}" up -d --wait --wait-timeout 900 nginx backend worker postgres redis egress-proxy clamav file-processor

step "5/12 Migraciones: aplicar, revertir todo y volver a aplicar sobre una base vacía"
"${COMPOSE[@]}" --profile check run --rm tools node scripts/migrate.js verify
"${COMPOSE[@]}" --profile check run --rm tools node scripts/seed.js system

step "6/12 Tests de base de datos (privilegios, triggers, seeds, bootstrap)"
"${COMPOSE[@]}" --profile check run --rm tools node --test --test-concurrency=1 "tests/**/*.test.js"

step "7/12 Tests unitarios, de integración y de seguridad del backend (con cobertura)"
"${COMPOSE[@]}" --profile check run --rm tests

step "8/12 Navegador: login con MFA y pantallas del núcleo sin violaciones de CSP"
printf 'E2e-%s' "$(openssl rand -hex 16)" > "$SECRETS_DIR/e2e_admin_password"
chmod 644 "$SECRETS_DIR/e2e_admin_password"
"${COMPOSE[@]}" --profile check run --rm -T \
  -e BOOTSTRAP_USERNAME=e2e.admin -e BOOTSTRAP_EMAIL=e2e.admin@empresa.test \
  -e BOOTSTRAP_DISPLAY_NAME="Administrador E2E" -e BOOTSTRAP_AREA="Administración E2E" \
  -e BOOTSTRAP_PASSWORD_FILE=/run/e2e/password \
  -v "$PWD/$SECRETS_DIR/e2e_admin_password:/run/e2e/password:ro" \
  tools node scripts/bootstrap-admin.js
"${COMPOSE[@]}" --profile check run --rm e2e

step "9/12 Verificación de la cadena de auditoría (después de todo lo que auditaron los tests y el navegador)"
"${COMPOSE[@]}" --profile check run --rm tools node scripts/audit-verify.js

step "10/12 Auditoría de dependencias"
npm audit --audit-level=high
(cd backend && npm audit --audit-level=high)
(cd database && npm audit --audit-level=high)

step "11/12 Detección de secretos en el historial de Git"
docker run --rm -v "$PWD:/repo:ro" "$GITLEAKS_IMAGE" git /repo --redact --no-banner

step "12/12 Escaneo de imágenes (vulnerabilidades altas y críticas con corrección disponible)"
for image in "${SCANNED_IMAGES[@]}"; do
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v enviotec-trivy-cache:/root/.cache/trivy \
    "$TRIVY_IMAGE" image --quiet --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$image"
done

printf '\n==> npm run check: todo en verde\n'
