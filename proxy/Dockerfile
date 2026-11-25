# syntax=docker/dockerfile:1
# Edge proxy (ADR-001): TLS, static frontend, /api to the backend, security
# headers. Build context: repository root.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
# The base image lags behind Alpine security fixes (Trivy found brotli-libs,
# curl, libexpat, musl, zlib and libxslt in successive builds): every
# package is upgraded at build time. curl is not needed (the healthcheck
# uses busybox wget). Review when the base image is updated.
# nginx itself: the image's nginx.org package (1.30.6) has CVEs fixed in
# Alpine's 1.30.7; the dynamic modules pin the old version and are not used,
# so they go and nginx comes from Alpine. The image's unprivileged
# nginx.conf is kept (the package's default lands in .apk-new, removed).
USER root
RUN apk del --no-cache nginx-module-geoip nginx-module-image-filter nginx-module-njs nginx-module-xslt \
 && apk add --no-cache "nginx>=1.30.7" \
 && apk upgrade --no-cache \
 && apk del --no-cache curl \
 && rm -f /etc/nginx/nginx.conf.apk-new
USER 101
COPY proxy/default.conf /etc/nginx/conf.d/default.conf
COPY proxy/snippets/ /etc/nginx/snippets/
COPY frontend/public/ /usr/share/nginx/html/
COPY frontend/src/ /usr/share/nginx/html/src/
