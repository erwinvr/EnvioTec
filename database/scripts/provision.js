// Usage: node scripts/provision.js
// Creates (or brings up to date) the EnvioTec database on SQL Server with
// least privilege (A4, ADR-032). Runs once per environment with an
// administrative login, which is never used by the application:
//   DATABASE_ADMIN_URL_FILE      sqlserver://<admin>:<password>@<host>/master
//   MIGRATION_DATABASE_URL_FILE  the owner login and the database name
//   DATABASE_URL_FILE            the runtime login (same server and database)
// Result:
// - database <db> with a case-insensitive collation, read committed
//   snapshot (readers never block writers, as in PostgreSQL) and snapshot
//   isolation (the audit chain verification reads one consistent view);
// - login <owner>: owner of <db> only (dbo there), no server roles;
// - login <runtime>: user in <db>, member of the database role app_runtime,
//   which the migrations grant table by table;
// - both logins with the server's password policy.
// Passwords travel as parameters and are quoted inside T-SQL; they are never
// printed. Existing logins keep their password unless --reset-passwords.
import { readFileSync } from 'node:fs';
import { connectDatabase } from '../../backend/src/core/db/pool.js';
import { connectionOptions, parseDatabaseUrl } from '../../backend/src/core/db/connection-url.js';

const COLLATION = 'Latin1_General_100_CI_AS_SC';
const resetPasswords = process.argv.includes('--reset-passwords');

function secret(name) {
  const path = process.env[`${name}_FILE`];
  if (!path) throw new Error(`${name}_FILE es obligatoria`);
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

const admin = secret('DATABASE_ADMIN_URL');
const owner = parseDatabaseUrl(secret('MIGRATION_DATABASE_URL'));
const runtime = parseDatabaseUrl(secret('DATABASE_URL'));
if (owner.database !== runtime.database || owner.server !== runtime.server) {
  throw new Error('MIGRATION_DATABASE_URL y DATABASE_URL deben apuntar al mismo servidor y base');
}
if (owner.user === runtime.user) throw new Error('El login dueño y el de ejecución deben ser distintos');

const tls = {
  caCert: process.env.DATABASE_CA_CERT_FILE ? readFileSync(process.env.DATABASE_CA_CERT_FILE, 'utf8') : undefined,
  serverName: process.env.DATABASE_SERVER_NAME,
  trustServerCertificate: process.env.DATABASE_TRUST_SERVER_CERTIFICATE === 'true' && process.env.NODE_ENV !== 'production',
};

const connect = (url) => connectDatabase({ ...connectionOptions({ url, ...tls }, 'enviotec-provision'), requestTimeout: 120000 });

const ENSURE_LOGIN = `
  DECLARE @sql nvarchar(max);
  IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = $1)
  BEGIN
    SET @sql = N'CREATE LOGIN ' + QUOTENAME($1) + N' WITH PASSWORD = N''' + REPLACE($2, N'''', N'''''')
             + N''', DEFAULT_DATABASE = ' + QUOTENAME($3) + N', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF';
    EXEC (@sql);
    SELECT 'created' AS result;
  END
  ELSE IF $4 = 1
  BEGIN
    SET @sql = N'ALTER LOGIN ' + QUOTENAME($1) + N' WITH PASSWORD = N''' + REPLACE($2, N'''', N'''''') + N'''';
    EXEC (@sql);
    SELECT 'password_reset' AS result;
  END
  ELSE SELECT 'exists' AS result;`;

const master = await connect(admin);
try {
  await master.query(`
    IF DB_ID($1) IS NULL
    BEGIN
      DECLARE @sql nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME($1) + N' COLLATE ${COLLATION}';
      EXEC (@sql);
    END`, [owner.database]);
  await master.query(`
    DECLARE @sql nvarchar(max) = N'ALTER DATABASE ' + QUOTENAME($1) + N' SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE';
    IF (SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = $1) = 0 EXEC (@sql);
    SET @sql = N'ALTER DATABASE ' + QUOTENAME($1) + N' SET ALLOW_SNAPSHOT_ISOLATION ON';
    IF (SELECT snapshot_isolation_state FROM sys.databases WHERE name = $1) = 0 EXEC (@sql);`, [owner.database]);
  for (const login of [owner, runtime]) {
    const { rows } = await master.query(ENSURE_LOGIN, [login.user, login.password, owner.database, resetPasswords]);
    console.log(`Login ${login.user}: ${rows[0].result}`);
  }
  await master.query(`
    DECLARE @sql nvarchar(max) = N'ALTER AUTHORIZATION ON DATABASE::' + QUOTENAME($1) + N' TO ' + QUOTENAME($2);
    IF SUSER_SNAME((SELECT owner_sid FROM sys.databases WHERE name = $1)) <> $2 EXEC (@sql);`, [owner.database, owner.user]);
} finally {
  await master.end();
}

// Inside the database, as its owner: the runtime role and user.
const database = await connect(secret('MIGRATION_DATABASE_URL'));
try {
  await database.query(`
    IF DATABASE_PRINCIPAL_ID('app_runtime') IS NULL CREATE ROLE app_runtime;
    DECLARE @sql nvarchar(max);
    IF DATABASE_PRINCIPAL_ID($1) IS NULL
    BEGIN
      SET @sql = N'CREATE USER ' + QUOTENAME($1) + N' FOR LOGIN ' + QUOTENAME($1) + N' WITH DEFAULT_SCHEMA = dbo';
      EXEC (@sql);
    END;
    IF IS_ROLEMEMBER('app_runtime', $1) = 0
    BEGIN
      SET @sql = N'ALTER ROLE app_runtime ADD MEMBER ' + QUOTENAME($1);
      EXEC (@sql);
    END;`, [runtime.user]);
  console.log(`Base ${owner.database} lista: dueño ${owner.user}, ejecución ${runtime.user} (rol app_runtime).`);
} finally {
  await database.end();
}
