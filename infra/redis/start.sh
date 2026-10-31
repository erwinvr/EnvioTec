#!/bin/sh
# Starts Redis with one ACL user per service (ADR-003). Passwords come from
# Docker secrets and are written to the ACL file only as SHA-256 hashes.
set -eu

hash_secret() {
  tr -d '\n' < "$1" | sha256sum | cut -d ' ' -f 1
}

backend_hash=$(hash_secret /run/secrets/redis_backend_password)
worker_hash=$(hash_secret /run/secrets/redis_worker_password)

umask 077
cat > /tmp/users.acl <<EOF
user default off
user healthcheck on nopass -@all +ping
user backend on #${backend_hash} ~* &* +@all -@dangerous
user worker on #${worker_hash} ~* &* +@all -@dangerous
EOF

exec redis-server \
  --aclfile /tmp/users.acl \
  --appendonly yes \
  --maxmemory "${REDIS_MAXMEMORY:-256mb}" \
  --maxmemory-policy noeviction \
  --protected-mode yes \
  --dir /data
