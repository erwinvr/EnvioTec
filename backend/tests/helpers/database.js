import { readFileSync } from 'node:fs';
import { connectionOptions } from '../../src/core/db/connection-url.js';
import { connectDatabase } from '../../src/core/db/pool.js';

// Direct connections for tests and fixtures (ADR-032), with the same TLS
// rules as the application: the CA and server name of the environment, or,
// outside production, the server's own certificate.
//   owner    MIGRATION_DATABASE_URL_FILE (creates fixtures, reads anything)
//   runtime  DATABASE_URL_FILE (what the application may do)
const read = (variable) => readFileSync(process.env[variable], 'utf8').replace(/\r?\n$/, '');

function tls() {
  return {
    caCert: process.env.DATABASE_CA_CERT_FILE ? readFileSync(process.env.DATABASE_CA_CERT_FILE, 'utf8') : undefined,
    serverName: process.env.DATABASE_SERVER_NAME || undefined,
    trustServerCertificate: process.env.DATABASE_TRUST_SERVER_CERTIFICATE === 'true',
  };
}

const connect = (variable, name) => connectDatabase({
  ...connectionOptions({ url: read(variable), ...tls() }, name),
  requestTimeout: 60000,
  pool: { max: 4, min: 0 },
});

export const connectOwner = () => connect('MIGRATION_DATABASE_URL_FILE', 'enviotec-tests-owner');
export const connectRuntime = () => connect('DATABASE_URL_FILE', 'enviotec-tests-runtime');
