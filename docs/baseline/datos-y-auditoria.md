# Baseline — Modelo de datos y auditoría

> Parte de `docs/baseline.md` (baseline del prompt base), con la misma autoridad. No se modifica sin aprobación explícita.

## A4. Modelo de datos del núcleo

Todo proyecto parte con estas tablas. Los módulos de negocio de la Parte B se agregan en migraciones propias.

| Tabla | Propósito | Puntos clave |
| --- | --- | --- |
| `users` | Cuentas | `id` UUID, `username` y `email` únicos sin distinguir mayúsculas (`citext` o índice sobre `lower()`), `password_hash`, `status` (`active`, `disabled`, `locked`), `mfa_secret` cifrado, `password_changed_at`, `failed_login_count`, `locked_until`, `deleted_at` para soft delete, `created_by`, `updated_by` |
| `roles` | Agrupaciones de permisos | `name` único, `description`, `is_system` (roles del sistema no se borran) |
| `permissions` | Catálogo de acciones | `code` único (`users.create`), `description`. Se cargan **solo por seed/migración**, nunca desde la UI |
| `user_roles` | Asignación | PK compuesta, FK con `ON DELETE` restrictivo, `assigned_by`, `assigned_at` |
| `role_permissions` | Asignación | PK compuesta, FK, `granted_by`, `granted_at` |
| `sessions` | Sesiones server-side | `id` = **hash** del token (nunca el token en claro), `user_id`, `created_at`, `last_seen_at`, `expires_at`, `ip`, `user_agent`, `revoked_at`, `mfa_verified_at`, `reauth_at` |
| `password_reset_tokens` | Recuperación | Hash del token, `expires_at` corto, `used_at`, un solo uso |
| `audit_logs` | Auditoría | Ver A7. Append-only |

**Reglas generales:**

- Claves primarias **UUID** (`uniqueidentifier` con `NEWSEQUENTIALID()`, que mantiene el orden de inserción en el índice) para no exponer IDs secuenciales.
- Claves foráneas, `NOT NULL`, `UNIQUE` y `CHECK` donde corresponda. La integridad se garantiza en la base de datos, no solo en el código.
- Índices para cada FK y para los campos de búsqueda, filtro y ordenamiento de los listados.
- Fechas en `datetime2(3)`, almacenadas en **UTC**.
- `created_at` y `updated_at` en todas las tablas de negocio.
- **Soft delete** en usuarios (`deleted_at` + `status`) para preservar la auditoría. Las consultas por defecto excluyen registros borrados.

**Usuarios de base de datos con mínimo privilegio:**

| Login de SQL Server | Permisos | Uso |
| --- | --- | --- |
| `<base>_owner` | Dueño de la base (solo de ella), DDL | Solo aprovisionamiento, migraciones, seeds y bootstrap. Nunca usado por la app en ejecución |
| `<base>_runtime` (rol de base `app_runtime`) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` sobre tablas de negocio, según cada tabla; sobre `audit_logs`, **solo `SELECT` y `EXECUTE` del procedimiento que agrega eventos** | La aplicación |
| `app_readonly` | `SELECT` | Reportes y soporte, opcional |

Ningún login de la aplicación es administrador del servidor. El aprovisionamiento crea los logins con una credencial administrativa que la aplicación nunca usa, y las migraciones otorgan los permisos de forma explícita (ADR-032).

## A7. Auditoría

La auditoría es **append-only y protegida en la base de datos**, no solo en la aplicación.

**Campos de `audit_logs`:** `id`, `occurred_at` (UTC), `actor_user_id` (nulo si anónimo), `actor_session_id` (hash), `action` (por ejemplo `user.create`), `resource_type`, `resource_id`, `result` (`success`, `denied`, `failure`), `ip`, `user_agent`, `request_id`, `metadata` (JSONB con los cambios antes/después **sin datos sensibles**), `prev_hash` y `hash`.

**Eventos obligatorios:**

- Login exitoso, login fallido, bloqueo de cuenta, logout, expiración y revocación de sesión.
- Alta, modificación, desactivación y reactivación de usuarios.
- Cambio y reset de contraseña, alta y baja de MFA.
- Alta, modificación y borrado de roles; asignación y retiro de roles y permisos.
- **Todo 403** (intento de acceso sin permiso).
- Exportación de auditoría y acciones administrativas definidas en la Parte B.

**Protección:**

- El login de ejecución solo puede leer `audit_logs` y agregar eventos con el procedimiento `append_audit_log`; no tiene `INSERT`, `UPDATE` ni `DELETE` sobre la tabla. Un trigger rechaza `UPDATE` y `DELETE` incluso si se otorgaran por error.
- **Encadenamiento por hash:** cada registro guarda el hash del anterior. Un script de verificación detecta registros alterados o eliminados. La inserción debe serializarse (por ejemplo con un advisory lock) para que dos inserciones concurrentes no usen el mismo `prev_hash`.
- La escritura de auditoría ocurre en la **misma transacción** que la acción auditada cuando la acción modifica datos. Si la auditoría falla, la acción falla.
- La consulta requiere `audit.view`; la exportación, `audit.export` (que también se audita).
- Consulta paginada con filtros por fecha, actor, acción, recurso y resultado.
- Política de retención configurable; nunca se purga desde la aplicación.
