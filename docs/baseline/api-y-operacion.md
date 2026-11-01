# Baseline — API, errores, logging, configuración, Docker y CI

> Parte de `docs/baseline.md` (baseline del prompt base), con la misma autoridad. No se modifica sin aprobación explícita.

## A10. API, errores, logging y configuración

**API REST del núcleo** (versionada bajo `/api/v1`):

```text
POST   /api/v1/auth/login            POST   /api/v1/auth/logout
GET    /api/v1/auth/me               POST   /api/v1/auth/mfa/verify
POST   /api/v1/auth/password/change  POST   /api/v1/auth/reauth
GET    /api/v1/auth/sessions         DELETE /api/v1/auth/sessions/:id

GET    /api/v1/users                 POST   /api/v1/users
GET    /api/v1/users/:id             PATCH  /api/v1/users/:id
POST   /api/v1/users/:id/disable     POST   /api/v1/users/:id/enable
PUT    /api/v1/users/:id/roles       POST   /api/v1/users/:id/reset-password

GET    /api/v1/roles                 POST   /api/v1/roles
GET    /api/v1/roles/:id             PATCH  /api/v1/roles/:id
DELETE /api/v1/roles/:id             PUT    /api/v1/roles/:id/permissions

GET    /api/v1/permissions
GET    /api/v1/audit-logs            GET    /api/v1/audit-logs/export
GET    /health/live                  GET    /health/ready
```

La desactivación usa acciones explícitas (`disable`/`enable`) en lugar de `DELETE`, porque no es un borrado.

**Listados:** paginación en el backend (`page`, `pageSize` con máximo 100), ordenamiento por allowlist de columnas, búsqueda y filtros validados. Respuesta con `meta.total`, `meta.page`, `meta.pageSize`.

**Formato de respuesta único:**

```json
{ "success": true, "data": { }, "meta": { } }

{ "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Datos inválidos",
             "details": [{ "field": "email", "code": "invalid_format" }],
             "requestId": "01J..." } }
```

**Errores centralizados:** clases `AppError`, `ValidationError` (422), `AuthenticationError` (401), `AuthorizationError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429). Los errores de base de datos se traducen (por ejemplo, violación de `UNIQUE` → 409) sin exponer el SQL. Cualquier error no previsto → 500 genérico y log completo en el servidor.

**Logging estructurado (Pino):**

- JSON en producción; legible en desarrollo; silencioso en tests.
- Cada línea incluye `request_id`, `user_id` si existe, ruta, método, código y duración.
- **Redacción obligatoria** configurada en el logger: `password`, `token`, `cookie`, `authorization`, `x-csrf-token`, `mfa`, `secret` y cualquier campo marcado como sensible.
- Los logs de aplicación no reemplazan a la auditoría: son sistemas distintos.

**Configuración:** toda la configuración sale de variables de entorno, validadas con un schema al arrancar. Si falta una obligatoria o tiene un valor inválido, la app no arranca.

```text
NODE_ENV, PORT, LOG_LEVEL
DATABASE_URL (usuario app_runtime), MIGRATION_DATABASE_URL (usuario app_owner)
REDIS_URL
SESSION_IDLE_TIMEOUT_MIN, SESSION_ABSOLUTE_TIMEOUT_MIN
CSRF_SECRET, DATA_ENCRYPTION_KEY (cifrado de secretos MFA)
TRUST_PROXY (IP o CIDR del proxy)
APP_ORIGIN (para verificar Origin)
ARGON2_MEMORY_KIB, ARGON2_ITERATIONS, ARGON2_PARALLELISM
RATE_LIMIT_LOGIN_PER_IP, RATE_LIMIT_LOGIN_PER_ACCOUNT
```

Se entrega `.env.example` con valores de ejemplo no funcionales. `.env` está en `.gitignore` y `.dockerignore`. En producción, los secretos se inyectan como Docker secrets o desde el gestor de secretos que defina la Parte B.

## A11. Docker, CI y supply chain

**Docker:**

- Dockerfile **multi-stage**, imagen base mínima y fijada por versión (idealmente por digest).
- El contenedor corre como **usuario no root**, con `read_only: true` y `tmpfs` solo donde haga falta, `cap_drop: [ALL]` y `no-new-privileges`.
- Healthchecks en backend, PostgreSQL y Redis; el backend espera a que la base esté lista.
- Redes separadas: el proxy ve al backend; solo el backend ve a PostgreSQL y Redis. Sin puertos de base de datos publicados en producción.
- Volúmenes nombrados para los datos de PostgreSQL.
- `docker-compose.yml` sin secretos reales; `docker-compose.override.yml` solo para desarrollo (puertos locales, recarga en caliente).
- Las migraciones se ejecutan como un paso o contenedor separado con `MIGRATION_DATABASE_URL`, no al arrancar cada réplica.
- Límites de memoria y CPU por servicio.
- Apagado ordenado: el backend cierra conexiones al recibir `SIGTERM`.

**Dependencias:**

- Antes de agregar una dependencia: para qué sirve, si se puede resolver con funcionalidad nativa, mantenimiento activo, licencia y número de dependencias transitivas.
- `package-lock.json` versionado; instalación con `npm ci`.
- Versiones exactas, sin rangos amplios.

**Chequeos de calidad y seguridad** (se ejecutan con un solo comando, `npm run check`, y luego en el CI que defina la Parte B; fallan si algo no pasa):

1. `npm ci`
2. Lint (incluye reglas de seguridad del frontend y `eslint-plugin-security` en el backend)
3. Tests unitarios, de integración y de seguridad, con PostgreSQL y Redis reales en contenedores
4. Cobertura mínima definida (por ejemplo 80% en `core/` y services)
5. `npm audit --audit-level=high` o una herramienta SCA equivalente
6. Detección de secretos en el repositorio (gitleaks o equivalente)
7. Escaneo de la imagen Docker (Trivy o equivalente) sin vulnerabilidades altas o críticas
8. Verificación de que las migraciones aplican y revierten sobre una base vacía

Se configura una herramienta de actualización automática de dependencias (Dependabot o Renovate) cuando el repositorio lo permita.
