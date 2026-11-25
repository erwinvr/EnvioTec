# ADR-032: SQL Server en lugar de PostgreSQL

- **Estado:** Aceptado (requisito de la organización; pedido y aprobado por el usuario el 2026-11-24: "actualiza todo para que sea sobre sql server y no sobre postgre")
- **Fecha:** 2026-11-24
- **Reemplaza:** la base de datos de la baseline A2, ADR-010 (en lo que toca a PostgreSQL, UUIDv7 y particiones) y ADR-017 (en lo que toca a node-pg-migrate y a los roles de PostgreSQL)

## Contexto

La organización exige SQL Server. El servidor disponible es `192.168.200.108`: SQL Server 2022 **Enterprise** sobre Windows Server 2022, autenticación mixta y collation `SQL_Latin1_General_CP1_CI_AS`, externo al stack de Docker.

Hallazgos del diagnóstico inicial (2026-11-24):

| Hallazgo | Riesgo | Pendiente |
| --- | --- | --- |
| Versión **RTM 16.0.1000.6** (octubre de 2022), sin actualizaciones acumulativas ni de seguridad | Vulnerabilidades corregidas desde entonces quedan abiertas | R18: instalar la última CU o GDR de SQL Server 2022 |
| Certificado TLS `SSL_Self_Signed_Fallback`, que SQL Server genera solo y regenera en cada reinicio | El cifrado no autentica al servidor: es posible un intermediario en la red | R19: certificado de la CA interna para el nombre del servidor. Producción no arranca sin él (`DATABASE_CA_CERT`) |
| La credencial `sa`, con una clave débil, se compartió por chat | Cualquiera con el historial administra el servidor | R20: rotar la clave de `sa` (o deshabilitarlo) y usar un login administrativo nominal para el aprovisionamiento |

No hay datos de producción: el esquema se reescribe consolidado, sin traducir el historial de migraciones.

## Decisión

### Acceso a datos

- **Driver `mssql` 12.7.14** (sobre `tedious`), con licencia MIT y mantenido por el proyecto tediousjs. Reemplaza a `pg` y a `node-pg-migrate`.
- **Adaptador propio** en `backend/src/core/db/`, que conserva la interfaz que usaban los repositorios y servicios:
  - `query(text, params) → { rows, rowCount }`;
  - `withTransaction`;
  - `connect()` con `begin`, `commit` y `rollback`.

  Qué hace el adaptador:
  - Los marcadores `$1…$n` pasan a `@p1…@pn`. Los valores **siempre** viajan como parámetros, tipados según su tipo de JavaScript (A8).
  - Los `uniqueidentifier` se devuelven en minúsculas.
  - Las columnas JSON (lista `JSON_COLUMNS`) se devuelven ya interpretadas.
  - Los errores se traducen a los códigos SQLSTATE que la API ya manejaba (23505, 23503, 23514, 42501, 40P01, 22P02, 57014). `error-handler.js` no cambia.
- **El SQL sigue solo en los repositorios** (A2). Los servicios no cambian.

### Esquema

| PostgreSQL | SQL Server |
| --- | --- |
| `uuid` con `uuidv7()` | `uniqueidentifier` con `NEWSEQUENTIALID()` |
| `timestamptz` | `datetime2(3)` en UTC (`SYSUTCDATETIME()`); el calendario usa America/La_Paz (`SA Western Standard Time`) |
| `citext` | `nvarchar` con la collation de la base `Latin1_General_100_CI_AS_SC` (no distingue mayúsculas) |
| emails `citext` | `varchar(254)` con collation UTF-8 (`Latin1_General_100_CI_AS_SC_UTF8`) y una columna calculada y persistida `email_hash` (SHA-256 del email en minúsculas, UTF-8). Coincide con el hash que calcula Node, así que la supresión es una comparación indexada |
| `jsonb` y `text[]` | `nvarchar(max)` con `ISJSON(..., OBJECT/ARRAY)` en un CHECK |
| `inet` | `varchar(45)`; la aplicación solo acepta IP válidas |
| `bytea` | `varbinary` |
| CHECK con expresiones regulares | `LIKE` sobre una collation binaria (SQL Server 2022 no tiene regex). La aplicación valida lo mismo antes |
| `UNIQUE` sobre columnas que admiten NULL | Índice único filtrado (`WHERE … IS NOT NULL`), porque SQL Server solo admite un NULL por restricción `UNIQUE` |
| Triggers `BEFORE` por fila | Triggers `AFTER`/`INSTEAD OF` por sentencia, que lanzan `THROW 51000` (regla) o `51001` (privilegio) |
| `updated_at` por trigger | Lo asigna cada `UPDATE` |
| `RETURNING` | `OUTPUT`. En las tablas con triggers de guarda, a través de una tabla variable (`returning()` en `core/db/sql.js`), porque SQL Server no permite `OUTPUT` directo ahí |
| `ON CONFLICT` | `IF NOT EXISTS (… WITH (UPDLOCK, HOLDLOCK))` o `MERGE … WITH (HOLDLOCK)` |
| `FOR UPDATE` / `SKIP LOCKED` | `WITH (UPDLOCK, ROWLOCK)` / `READPAST` |
| `pg_advisory_xact_lock` | `sp_getapplock` con `@LockOwner = 'Transaction'` |
| Particiones por rango | Una función y un esquema de partición mensual por tabla (`audit_logs`, `message_events`), mantenidos por `create_monthly_partitions`, que corre `WITH EXECUTE AS OWNER` |

### Seguridad de la base

- **Mínimo privilegio** (A4). `scripts/provision.js` corre una sola vez por ambiente, con una credencial administrativa que la aplicación nunca usa, y crea:
  - el login `<base>_owner`, dueño **solo** de la base (sin roles del servidor), que usan migraciones, seeds y bootstrap;
  - el login `<base>_runtime`, miembro únicamente del rol de base `app_runtime`, al que las migraciones otorgan permisos tabla por tabla (y columna por columna donde corresponde);
  - la base con collation sin distinción de mayúsculas, `READ_COMMITTED_SNAPSHOT` (las lecturas no bloquean escrituras, como en PostgreSQL) y `ALLOW_SNAPSHOT_ISOLATION` (la verificación de la cadena lee una sola vista).
- **Auditoría append-only** (A7):
  - el login de ejecución solo puede `EXECUTE dbo.append_audit_log` y leer;
  - no tiene `INSERT`, `UPDATE` ni `DELETE` sobre `audit_logs`;
  - el trigger `INSTEAD OF UPDATE, DELETE` rechaza cambios incluso del dueño;
  - `TRUNCATE` exige `ALTER`, que no tiene.

  La cadena de hashes se calcula en la base (`audit_log_canonical`: arreglo JSON de los campos, SHA-256 en UTF-8) bajo un bloqueo de aplicación. `audit-verify` la recalcula igual.
- **TLS**:
  - siempre cifrado;
  - en producción, el certificado se valida contra `DATABASE_CA_CERT` por el nombre `DATABASE_SERVER_NAME`; la configuración rechaza `DATABASE_TRUST_SERVER_CERTIFICATE` en producción;
  - en desarrollo se acepta el certificado autofirmado del servidor de la organización (R19).
- **Red**:
  - backend, worker y tools salen por la red `database`, la única con ruta hacia el servidor;
  - el firewall del host la limita al servidor y al puerto 1433 (`docs/deployment.md`).
- **Statement timeout**: SQL Server no tiene un límite por login como `statement_timeout`. El driver corta cada consulta a los `DATABASE_STATEMENT_TIMEOUT_MS` (10 s por defecto).

### Verificación

- `npm run check` levanta su **propio** SQL Server 2022 (imagen oficial, edición Developer, fijada por digest), con TLS forzado y un certificado firmado por una CA efímera del check. Valida el certificado igual que en producción y nunca toca el servidor de la organización.
- Aprovisiona, aplica, revierte y vuelve a aplicar las migraciones, y corre las mismas suites de antes.
- Los tests de base de datos se reestructuraron. En SQL Server, un error lanzado por un trigger revierte la transacción completa: cada caso que debe fallar corre en su propia transacción, con sus datos, y siempre se revierte (`failsWith`).

## Consecuencias

- Cambia la baseline A2 (base de datos, driver y migraciones). El usuario aprobó el cambio explícitamente.
- Una dependencia menos (`node-pg-migrate`). El runner de migraciones es propio (`database/scripts/lib/migrator.js`, unas 70 líneas).
- **Desarrollo**:
  - pasa a la base `enviotec` del servidor de la organización;
  - los datos de prueba que había en PostgreSQL no se migran: se vuelve a crear el superadmin con el bootstrap y a configurar el MFA;
  - el volumen `enviotec_pgdata` queda sin uso, y el usuario decide cuándo borrarlo.
- **Respaldo y restauración**: los hace el equipo de base de datos con las herramientas de SQL Server (`BACKUP DATABASE`, ver runbook).
- **Licencias**: Enterprise ya está licenciado por la organización; el check usa la edición Developer, gratuita para pruebas.
