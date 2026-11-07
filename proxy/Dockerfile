# syntax=docker/dockerfile:1
# Edge proxy (ADR-001): TLS, static frontend, /api to the backend, security
# headers. Build context: repository root.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
# The base image ships packages with known vulnerabilities fixed upstream
# (Trivy: brotli-libs and curl 2026-10-31; libexpat, musl and zlib
# 2026-11-07). curl is not needed: the healthcheck uses busybox wget.
# Remove this step once the base image includes the fixes.
USER root
RUN apk upgrade --no-cache brotli-libs libexpat musl musl-utils zlib \
 && apk del --no-cache curl
USER 101
COPY proxy/default.conf /etc/nginx/conf.d/default.conf
COPY proxy/snippets/ /etc/nginx/snippets/
COPY frontend/public/ /usr/share/nginx/html/
COPY frontend/src/ /usr/share/nginx/html/src/
