# EnvioTec

Plataforma interna para enviar campañas de correo masivo con un PDF adjunto, a partir de plantillas Word con variables, con cuotas por usuario, aprobación de campañas y reportes. El envío usa Mailchimp Transactional (Mandrill).

> **Estado:** Fase 8 (módulos de negocio). Núcleo completo (API y pantallas). Entregadas 8.1 (remitentes y cuotas), 8.2 (contactos, importación CSV aislada con antivirus, supresión y anonimización), 8.3 (plantillas .docx inspeccionadas y vista previa aislada) y 8.4 (campañas con PDF inspeccionado y aprobación maker-checker). Siguiente: 8.5 envío y sincronización con Mandrill. Todavía no hay pantallas (Fase 7) ni módulos de negocio. El plan completo está en [docs/architecture.md](docs/architecture.md#6-plan-de-fases).

## Documentación

| Documento | Contenido |
| --- | --- |
| [docs/baseline.md](docs/baseline.md) | Baseline de seguridad y metodología (Partes A y C) |
| [docs/project-spec.md](docs/project-spec.md) | Ficha de EnvioTec (Parte B) |
| [docs/architecture.md](docs/architecture.md) | Componentes, modelo de datos, permisos, dependencias, plan de fases |
| [docs/security.md](docs/security.md) | Modelo de amenazas y revisión de seguridad por fase |
| [docs/decisions/](docs/decisions/README.md) | Decisiones de arquitectura (ADR) |
| [docs/openapi.yaml](docs/openapi.yaml) | Especificación de la API |
| [docs/hardening.md](docs/hardening.md) | Informe de hardening (ASVS 5.0 nivel 2) y hallazgos |
| [docs/runbook.md](docs/runbook.md) | Operación: despliegue, respaldos, rotación de secretos, incidentes |

## Arquitectura

```text
Navegador ──HTTPS──▶ nginx ──▶ backend (Fastify) ──▶ PostgreSQL 18
                       │            │           └──▶ Redis 8
                       │            └──▶ egress-proxy (Squid) ──▶ mandrillapp.com
                       └── frontend estático (JS Vanilla, ES Modules)
worker ──▶ PostgreSQL, Redis, egress-proxy
```

- **nginx:** TLS, frontend en `/`, `/api/*` y `/health/*` al backend, headers de seguridad (ADR-001).
- **backend:** API sin estado; varias réplicas posibles.
- **file-processor:** inspección de archivos no confiables (CSV, .docx, PDF) en la red aislada `files`, sin base de datos ni internet; solo ve Redis (sus colas) y ClamAV (ADR-004, ADR-022).
- **clamav:** antivirus; actualiza firmas a través del proxy de egreso.
- **worker:** trabajos periódicos (ADR-020): particiones mensuales, control horario de vigencia de cuentas locales y revisión de AD cada 15 minutos; las colas de envío llegan en la Fase 8.
- **egress-proxy:** única salida a internet, con allowlist de dominios (ADR-009, ADR-015).
- Redes Docker `edge`, `data` y `egress` internas (sin internet); PostgreSQL y Redis sin puertos publicados en producción.
- Todos los contenedores corren sin root, con sistema de archivos de solo lectura, `cap_drop: ALL`, `no-new-privileges`, healthcheck y límites de CPU y memoria.

## Requisitos

- Docker 24 o superior con Docker Compose v2.24 o superior.
- Node.js 22.13 o superior en el host (solo para lint y auditoría; el backend corre en Node.js 26 LTS dentro del contenedor).
- `openssl` (para generar los secretos de desarrollo).

## Puesta en marcha (desarrollo)

```bash
npm ci                         # herramientas de lint
npm run secrets:dev            # genera ./secrets (aleatorios) y un certificado autofirmado
docker compose up -d --build --wait
curl --cacert secrets/tls_cert https://localhost/health/ready
```

Base de datos (la primera vez y después de cada cambio de migraciones):

```bash
docker compose run --rm tools node scripts/migrate.js up     # aplica migraciones (usuario app_owner)
docker compose run --rm tools node scripts/seed.js system       # permisos, roles iniciales y parámetros
docker compose run --rm tools node scripts/seed.js dev          # áreas de ejemplo (solo desarrollo)
docker compose run --rm -it tools node scripts/bootstrap-admin.js       # superadmin inicial (pide los datos)
docker compose run --rm -it tools node scripts/bootstrap-admin.js --emergency   # cuenta de emergencia
```

Verificación de la cadena de auditoría (también corre en `npm run check`): `docker compose run --rm tools node scripts/audit-verify.js [--from 2026-10-01]`. Termina con código 2 si detecta un registro alterado, eliminado o insertado fuera de la cadena.

El bootstrap no tiene credenciales por defecto: pide usuario, email, nombre, área y contraseña (sin mostrarla), y la valida con la política de contraseñas. Solo crea el superadmin si todavía no existe uno, y queda auditado. En el primer login el superadmin debe configurar el MFA (`POST /api/v1/auth/mfa/enroll/start` y `/confirm`). Otros comandos de migración: `node scripts/migrate.js down [n|all]` y `node scripts/migrate.js verify`.

Abrir `https://localhost` en el navegador (aceptar el certificado autofirmado o importar `secrets/tls_cert`).

`docker compose up` aplica automáticamente `docker-compose.override.yml` (solo desarrollo): backend y worker con recarga en caliente y logs legibles, y PostgreSQL y Redis publicados en `127.0.0.1` (puertos 5432 y 6379).

Comandos útiles:

```bash
docker compose ps                         # estado y healthchecks
docker compose logs -f backend worker     # logs
docker compose down                       # detener (conserva los datos)
docker compose down -v                    # detener y borrar volúmenes (PostgreSQL y Redis)
```

Para regenerar los secretos: `npm run secrets:dev -- --force` y luego `docker compose down -v`, porque PostgreSQL solo lee las contraseñas de los roles al crear su volumen.

## Producción

Se usa solo `docker-compose.yml` (sin el override):

```bash
docker compose -f docker-compose.yml up -d --build --wait
```

Los secretos se colocan en el directorio `SECRETS_DIR` (por defecto `./secrets`), uno por archivo, con los nombres declarados al final de `docker-compose.yml`. El certificado TLS (`tls_cert`, `tls_key`) lo emite la CA interna de la organización. Despliegue, actualización, respaldo y restauración, rotación de secretos, revocación masiva de sesiones y puesta en marcha del envío: [docs/runbook.md](docs/runbook.md).

## Variables de entorno

La configuración se valida al arrancar: si falta una variable obligatoria, tiene un valor inválido o un secreto es débil, el proceso no arranca y lista los problemas (nunca los valores). Los secretos se leen desde archivos con la convención `<VARIABLE>_FILE`.

La lista completa, con valores de ejemplo, está en [.env.example](.env.example).

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `NODE_ENV` | Sí | `development`, `test` o `production` |
| `DATABASE_URL(_FILE)` | Sí | Conexión con el usuario `app_runtime` |
| `REDIS_URL(_FILE)` | Sí | Conexión con el usuario ACL del servicio |
| `CSRF_SECRET(_FILE)` | Sí (API) | Secreto aleatorio de al menos 32 caracteres |
| `DATA_ENCRYPTION_KEY(_FILE)` | Sí (API) | 32 bytes aleatorios en base64 |
| `TRUST_PROXY` | Sí (API) | IP o CIDR de nginx; nunca un comodín |
| `APP_ORIGIN` | Sí (API) | Origen https de la aplicación |
| `SESSION_*`, `ARGON2_*`, `RATE_LIMIT_*`, `LOCKOUT_*`, `PASSWORD_RESET_TTL_MIN` | No | Con valores por defecto seguros |
| `AD_ENABLED` | No | `true` habilita el login con AD (por defecto `false`) y exige las `LDAP_*` |
| `LDAP_URL`, `LDAP_CA_CERT(_FILE)`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD(_FILE)`, `LDAP_BASE_DN`, `LDAP_ALLOWED_GROUP_DN` | Con AD | Solo `ldaps://`; CA interna; cuenta de servicio de solo lectura; grupo habilitado |
| `MANDRILL_SYSTEM_API_KEY(_FILE)`, `MAIL_FROM` | No | Correo del sistema (recuperación de contraseña); sin la key el correo queda deshabilitado |
| `MANDRILL_CAMPAIGNS_API_KEY(_FILE)` | No | Solo el worker: envío de campañas y sincronización de eventos (ADR-024); sin la key no se envía nada |
| `MANDRILL_API_URL`, `SENDING_BATCH_SIZE` | No | API de Mandrill (por defecto `https://mandrillapp.com/api/1.0`) y destinatarios por lote (100) |

## Verificación (`npm run check`)

```bash
npm run check
```

Ejecuta, en orden y deteniéndose en el primer fallo:

1. `npm ci`
2. Lint (ESLint con `eslint-plugin-security` en el backend y prohibición de sinks HTML en el frontend) y tests del frontend
3. Secretos efímeros para el entorno de verificación
4. Construcción de imágenes y arranque del stack completo (proyecto Compose aparte, sin puertos publicados)
5. Migraciones: aplicar, revertir todo y volver a aplicar sobre la base vacía; seed de sistema
6. Tests de base de datos (`database/tests`): privilegios de `app_runtime`, triggers, restricciones, seeds y bootstrap
7. Tests unitarios, de integración y de seguridad del backend dentro de un contenedor conectado a las redes internas, con cobertura mínima del 80 % en `backend/src/core` y `backend/src/modules`
8. Navegador real (Playwright, ADR-021): login con MFA, cada pantalla del núcleo, altas, cambio de idioma y cierre de sesión; falla ante cualquier violación de CSP o error en consola
9. Verificación de la cadena de auditoría, sobre todo lo que auditaron los tests y el navegador
10. `npm audit --audit-level=high` (raíz, backend y database)
11. gitleaks sobre el historial de Git
12. Trivy sobre las imágenes `backend`, `nginx`, `egress-proxy` y `tools` (altas y críticas con corrección disponible)

No interfiere con un stack de desarrollo en ejecución: usa otro nombre de proyecto, otras subredes y otros secretos, y los borra al terminar. Necesita salida a internet (paquetes npm, base de Trivy y el test que verifica el túnel hacia Mandrill).

## Tests

- `backend/tests/unit`: configuración, logger, errores, health, contraseñas, TOTP (vectores de los RFC 4226 y 6238), cifrado, CSRF, etapas de sesión, bloqueo, rate limiter, proveedor de AD y correo del sistema.
- `backend/tests/integration`: health con PostgreSQL y Redis reales; matriz de autorización (401/403/éxito, 403 auditados) y estados de sesión inválidos; login, sesiones, CSRF, enumeración, bloqueo y rate limiting; MFA, cambio y recuperación de contraseña; AD con un directorio simulado (ADR-019); usuarios, áreas, roles, equivalencias de AD, parámetros y reglas contra escalamiento; trabajos de vigencia y de revisión de AD.
- `backend/tests/security`: inventario de rutas (deny by default), exposición de errores, proxy confiable, headers de nginx, TLS y control de egreso.
- `database/tests`: privilegios de `app_runtime` (auditoría append-only, sin DDL), triggers y restricciones (origen único, roles administrativos solo locales, roles de sistema), seeds y bootstrap.

- `frontend/tests`: diccionarios (mismas claves en español e inglés, ninguna clave faltante), router, cliente API, manejo de errores, validación de formularios y URLs seguras (`npm run test:frontend`, sin navegador).
- `e2e/run.mjs`: recorrido en Chromium real dentro de `npm run check`.

Los tests de integración y los del stack se ejecutan solo dentro de `npm run check`; fuera de él aparecen como omitidos.

## Estructura

```text
backend/            API y worker (Fastify, Node.js 26)
  src/core/         config, logging, errores, http, seguridad, db, redis, ciclo de vida
  src/modules/      un módulo por dominio (health en esta fase)
  tests/            unit, integration, security
frontend/           HTML + JS Vanilla (ES Modules), servido por nginx
  src/core/         dom seguro, cliente API, auth, router, i18n, errores
  src/components/   tabla, formulario, modal, diálogos, toast, paginación, navegación
  src/pages/        autenticación, inicio, mi cuenta y administración
  src/i18n/         diccionarios es y en
e2e/                verificación en navegador (Playwright)
proxy/              configuración de nginx y su Dockerfile
infra/              egress-proxy (Squid) y arranque de Redis con ACL
database/           migraciones, seeds (system/dev), scripts (migrate, seed, bootstrap) y sus tests
database/init/      creación de roles de PostgreSQL (una vez, al crear el volumen)
scripts/            generación de secretos y npm run check
spikes/mandrill/    scripts de exploración de la fase 0.5 (no son código de producción)
docs/               especificación, arquitectura, seguridad, ADR, OpenAPI
```
