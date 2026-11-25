import { NOW, dottedCode } from '../scripts/lib/sql-checks.js';

// Audit log (A7, ADR-010, ADR-018, ADR-032): append-only, partitioned by
// month, hash-chained.
// - Partitions: a partition function per table (RANGE RIGHT on the first
//   instant of each UTC month). create_monthly_partitions() keeps months
//   ahead; it runs as the owner, so app_runtime gets no DDL rights.
// - append_audit_log() is the only way to write: it serializes the inserts
//   with an application lock, reads the previous hash and computes the new
//   one, so two concurrent inserts never share prev_hash. app_runtime may
//   EXECUTE it and SELECT the table, but has no INSERT, UPDATE or DELETE.
// - audit_log_canonical(): the JSON array of the row's fields hashed with
//   SHA-256 (UTF-8); the chain verification recomputes it the same way.

export const up = `
DECLARE @month datetime2(3) = DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1);
DECLARE @sql nvarchar(max) = N'CREATE PARTITION FUNCTION pf_audit_logs (datetime2(3)) AS RANGE RIGHT FOR VALUES (''' + CONVERT(nvarchar(30), @month, 126) + N''')';
EXEC (@sql);
GO
CREATE PARTITION SCHEME ps_audit_logs AS PARTITION pf_audit_logs ALL TO ([PRIMARY]);
GO

CREATE TABLE audit_logs (
  seq              bigint IDENTITY(1, 1) NOT NULL,
  id               uniqueidentifier NOT NULL,
  occurred_at      datetime2(3) NOT NULL DEFAULT ${NOW},
  actor_type       varchar(10) NOT NULL CHECK (actor_type IN ('user', 'system', 'anonymous')),
  actor_user_id    uniqueidentifier NULL CONSTRAINT audit_logs_actor_user_id_fkey REFERENCES users (id),
  actor_session_id varbinary(32) NULL CHECK (actor_session_id IS NULL OR DATALENGTH(actor_session_id) = 32),
  action           varchar(100) NOT NULL CHECK (${dottedCode('action')}),
  resource_type    nvarchar(50) NULL,
  resource_id      nvarchar(100) NULL,
  result           varchar(10) NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  ip               varchar(45) NULL,
  user_agent       nvarchar(512) NULL,
  request_id       nvarchar(64) NULL,
  metadata         nvarchar(max) NOT NULL DEFAULT N'{}' CHECK (ISJSON(metadata, OBJECT) = 1),
  prev_hash        varbinary(32) NULL CHECK (prev_hash IS NULL OR DATALENGTH(prev_hash) = 32),
  hash             varbinary(32) NOT NULL CHECK (DATALENGTH(hash) = 32),
  CONSTRAINT audit_logs_actor CHECK ((actor_type = 'user' AND actor_user_id IS NOT NULL) OR (actor_type <> 'user' AND actor_user_id IS NULL)),
  CONSTRAINT audit_logs_pkey PRIMARY KEY CLUSTERED (seq, occurred_at),
  CONSTRAINT audit_logs_id_occurred_at_key UNIQUE (id, occurred_at)
) ON ps_audit_logs (occurred_at);

CREATE INDEX audit_logs_occurred_at_idx ON audit_logs (occurred_at);
CREATE INDEX audit_logs_actor_user_id_idx ON audit_logs (actor_user_id, occurred_at);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, occurred_at);
CREATE INDEX audit_logs_result_idx ON audit_logs (result, occurred_at);
GO

-- Defense in depth (A7): even with an UPDATE or DELETE grant given by
-- mistake, the rows cannot change. TRUNCATE needs ALTER, which app_runtime
-- does not have.
CREATE TRIGGER audit_logs_no_update ON audit_logs INSTEAD OF UPDATE, DELETE
AS
BEGIN
  THROW 51001, 'audit_logs is append-only', 1;
END
GO

CREATE FUNCTION dbo.audit_log_canonical (
  @id uniqueidentifier, @occurred_at datetime2(3), @actor_type varchar(10), @actor_user_id uniqueidentifier,
  @actor_session_id varbinary(32), @action varchar(100), @resource_type nvarchar(50), @resource_id nvarchar(100),
  @result varchar(10), @ip varchar(45), @user_agent nvarchar(512), @request_id nvarchar(64), @metadata nvarchar(max),
  @prev_hash varbinary(32)
) RETURNS varbinary(32)
AS
BEGIN
  DECLARE @canonical TABLE (text varchar(max) COLLATE Latin1_General_100_BIN2_UTF8);
  INSERT INTO @canonical VALUES (JSON_ARRAY(
    LOWER(CONVERT(nvarchar(36), @id)),
    CONVERT(nvarchar(30), DATEDIFF_BIG(MILLISECOND, '1970-01-01', @occurred_at)),
    @actor_type, LOWER(CONVERT(nvarchar(36), @actor_user_id)), LOWER(CONVERT(nvarchar(64), @actor_session_id, 2)),
    @action, @resource_type, @resource_id, @result, @ip, @user_agent, @request_id,
    JSON_QUERY(@metadata), LOWER(CONVERT(nvarchar(64), @prev_hash, 2))
    NULL ON NULL));
  RETURN (SELECT HASHBYTES('SHA2_256', CAST(text AS varbinary(max))) FROM @canonical);
END
GO

CREATE PROCEDURE dbo.append_audit_log
  @actor_type varchar(10), @actor_user_id uniqueidentifier, @actor_session_id varbinary(32), @action varchar(100),
  @resource_type nvarchar(50), @resource_id nvarchar(100), @result varchar(10), @ip varchar(45),
  @user_agent nvarchar(512), @request_id nvarchar(64), @metadata nvarchar(max), @id uniqueidentifier OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  DECLARE @own_transaction bit = 0, @status int, @at datetime2(3), @prev varbinary(32);
  IF @@TRANCOUNT = 0 BEGIN BEGIN TRANSACTION; SET @own_transaction = 1; END;
  -- Held until the end of the caller's transaction: the next insert waits
  -- and then reads this row as its predecessor.
  EXEC @status = sp_getapplock @Resource = 'enviotec.audit_logs', @LockMode = 'Exclusive',
                               @LockOwner = 'Transaction', @LockTimeout = 15000;
  IF @status < 0 THROW 51002, 'audit lock not acquired', 1;
  SET @id = NEWID();
  SET @at = SYSUTCDATETIME();
  SET @metadata = COALESCE(@metadata, N'{}');
  SELECT TOP (1) @prev = hash FROM audit_logs ORDER BY seq DESC;
  INSERT INTO audit_logs (id, occurred_at, actor_type, actor_user_id, actor_session_id, action, resource_type,
                          resource_id, result, ip, user_agent, request_id, metadata, prev_hash, hash)
  VALUES (@id, @at, @actor_type, @actor_user_id, @actor_session_id, @action, @resource_type, @resource_id, @result,
          @ip, @user_agent, @request_id, @metadata, @prev,
          dbo.audit_log_canonical(@id, @at, @actor_type, @actor_user_id, @actor_session_id, @action, @resource_type,
                                  @resource_id, @result, @ip, @user_agent, @request_id, @metadata, @prev));
  IF @own_transaction = 1 COMMIT;
END
GO

-- Splits the partition function of a partitioned table so that every UTC
-- month from the current one up to @months_ahead later has its own
-- partition. Returns how many were created and whether month +3 exists.
CREATE PROCEDURE dbo.create_monthly_partitions @table sysname, @months_ahead int
WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  IF @table NOT IN ('audit_logs', 'message_events') THROW 51000, 'table is not partitioned by month', 1;
  IF @months_ahead < 0 OR @months_ahead > 24 THROW 51000, 'months_ahead must be between 0 and 24', 1;
  DECLARE @function sysname = N'pf_' + @table, @scheme sysname = N'ps_' + @table;
  DECLARE @month datetime2(3) = DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1);
  DECLARE @i int = 0, @created int = 0, @boundary datetime2(3), @sql nvarchar(max);
  WHILE @i <= @months_ahead
  BEGIN
    SET @boundary = DATEADD(month, @i, @month);
    IF NOT EXISTS (
      SELECT 1 FROM sys.partition_range_values v JOIN sys.partition_functions f ON f.function_id = v.function_id
       WHERE f.name = @function AND CAST(v.value AS datetime2(3)) = @boundary
    )
    BEGIN
      SET @sql = N'ALTER PARTITION SCHEME ' + QUOTENAME(@scheme) + N' NEXT USED [PRIMARY];
                   ALTER PARTITION FUNCTION ' + QUOTENAME(@function) + N'() SPLIT RANGE (@boundary);';
      EXEC sp_executesql @sql, N'@boundary datetime2(3)', @boundary = @boundary;
      SET @created += 1;
    END;
    SET @i += 1;
  END;
  SELECT @created AS created,
         CASE WHEN EXISTS (
           SELECT 1 FROM sys.partition_range_values v JOIN sys.partition_functions f ON f.function_id = v.function_id
            WHERE f.name = @function AND CAST(v.value AS datetime2(3)) = DATEADD(month, 3, @month)
         ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS ok;
END
GO

EXEC dbo.create_monthly_partitions 'audit_logs', 12;
GO

GRANT SELECT ON audit_logs TO app_runtime;
GRANT EXECUTE ON dbo.append_audit_log TO app_runtime;
GRANT EXECUTE ON dbo.audit_log_canonical TO app_runtime;
GRANT EXECUTE ON dbo.create_monthly_partitions TO app_runtime;
`;

export const down = `
DROP PROCEDURE dbo.create_monthly_partitions;
DROP PROCEDURE dbo.append_audit_log;
DROP TABLE audit_logs;
DROP FUNCTION dbo.audit_log_canonical;
GO
DROP PARTITION SCHEME ps_audit_logs;
DROP PARTITION FUNCTION pf_audit_logs;
`;
