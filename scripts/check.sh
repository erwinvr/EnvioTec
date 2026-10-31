#!/usr/bin/env bash
# Quality and security checks (A11). Same command locally and in Jenkins:
#   npm run check
# Requires Node.js (lint and audit on the host) and Docker (everything else).
# Fails on the first step that does not pass.
set -euo pipefail

cd "$(dirname "$0")/.."

GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
TRIVY_IMAGE="aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c"
SCANNED_IMAGES=(enviotec/backend:local enviotec/nginx:local enviotec/egress-proxy:local)

# Separate project, secrets and subnets, so the check never touches a running
# development stack.
export COMPOSE_PROJECT_NAME=enviotec-check
export SECRETS_DIR=./.check-secrets
export EDGE_SUBNET=172.31.110.0/24
export NGINX_IP=172.31.110.10
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.check.yml)

cleanup() {
  "${COMPOSE[@]}" --profile check down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$SECRETS_DIR"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$1"; }

step "1/8 npm ci"
npm ci --no-audit --no-fund

step "2/8 Lint"
npm run lint

step "3/8 Secretos efímeros para el entorno de verificación"
bash scripts/generate-dev-secrets.sh "$SECRETS_DIR" --force

step "4/8 Construcción de imágenes y arranque del stack"
"${COMPOSE[@]}" --profile check build
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 nginx backend worker postgres redis egress-proxy

step "5/8 Tests unitarios, de integración y de seguridad (con cobertura)"
"${COMPOSE[@]}" --profile check run --rm tests

step "6/8 Auditoría de dependencias"
npm audit --audit-level=high
(cd backend && npm audit --audit-level=high)

step "7/8 Detección de secretos en el historial de Git"
docker run --rm -v "$PWD:/repo:ro" "$GITLEAKS_IMAGE" git /repo --redact --no-banner

step "8/8 Escaneo de imágenes (vulnerabilidades altas y críticas con corrección disponible)"
for image in "${SCANNED_IMAGES[@]}"; do
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v enviotec-trivy-cache:/root/.cache/trivy \
    "$TRIVY_IMAGE" image --quiet --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$image"
done

printf '\n==> npm run check: todo en verde\n'
