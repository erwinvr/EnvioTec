// Connection settings from a URL kept in a Docker secret (ADR-032):
//   sqlserver://<user>:<password>@<host>[:port]/<database>
// User and password may be percent-encoded. TLS is always on; the server
// certificate is validated against DATABASE_CA_CERT unless
// DATABASE_TRUST_SERVER_CERTIFICATE is true, which the configuration only
// accepts outside production.

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function parse(value) {
  if (typeof value !== 'string' || !value.startsWith('sqlserver://')) return null;
  let url;
  try {
    url = new URL(`http://${value.slice('sqlserver://'.length)}`);
  } catch {
    return null;
  }
  const database = url.pathname.slice(1);
  if (!url.username || !url.password || !url.hostname || url.search || url.hash || !DATABASE_NAME.test(database)) return null;
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    server: url.hostname,
    port: url.port ? Number(url.port) : 1433,
    database,
  };
}

export const isDatabaseUrl = (value) => parse(value) !== null;

export function parseDatabaseUrl(value) {
  const parsed = parse(value);
  if (!parsed) throw new Error('invalid database URL');
  return parsed;
}

export function connectionOptions({ url, caCert, trustServerCertificate = false, serverName }, applicationName) {
  const { user, password, server, port, database } = parseDatabaseUrl(url);
  return {
    user, password, server, port, database,
    options: {
      encrypt: true,
      trustServerCertificate: trustServerCertificate === true,
      ...(caCert ? { cryptoCredentialsDetails: { ca: caCert } } : {}),
      ...(serverName ? { serverName } : {}),
      appName: applicationName,
      enableArithAbort: true,
    },
  };
}
