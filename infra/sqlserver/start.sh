#!/bin/sh
# SQL Server of the check environment only (ADR-032): development and
# production use the organization's server. The sa password and the TLS
# certificate come from Docker secrets; encryption is forced, so clients
# validate the certificate against the check CA, as in production.
set -eu
cat > /var/opt/mssql/mssql.conf <<CONF
[network]
tlscert = /run/secrets/sqlserver_tls_cert
tlskey = /run/secrets/sqlserver_tls_key
tlsprotocols = 1.2
forceencryption = 1
CONF
MSSQL_SA_PASSWORD="$(cat /run/secrets/database_admin_password)"
export MSSQL_SA_PASSWORD
exec /opt/mssql/bin/sqlservr
