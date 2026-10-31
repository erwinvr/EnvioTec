# EnvioTec

Plataforma interna para enviar campañas de correo masivo con un PDF adjunto, a partir de plantillas Word con variables, con cuotas por usuario, aprobación de campañas y reportes. El envío usa Mailchimp Transactional (Mandrill).

> **Estado:** Fase 1 (base del proyecto). Todavía no hay login ni módulos de negocio. El plan completo está en [docs/architecture.md](docs/architecture.md#6-plan-de-fases).

## Documentación

| Documento | Contenido |
| --- | --- |
| [docs/baseline.md](docs/baseline.md) | Baseline de seguridad y metodología (Partes A y C) |
| [docs/project-spec.md](docs/project-spec.md) | Ficha de EnvioTec (Parte B) |
| [docs/architecture.md](docs/architecture.md) | Componentes, modelo de datos, permisos, dependencias, plan de fases |
| [docs/security.md](docs/security.md) | Modelo de amenazas y revisión de seguridad por fase |
| [docs/decisions/](docs/decisions/README.md) | Decisiones de arquitectura (ADR) |
| [docs/openapi.yaml](docs/openapi.yaml) | Especificación de la API |

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
- **worker:** procesos en segundo plano (colas a partir de la Fase 3).
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

Los secretos se colocan en el directorio `SECRETS_DIR` (por defecto `./secrets`), uno por archivo, con los nombres declarados al final de `docker-compose.yml`. El certificado TLS (`tls_cert`, `tls_key`) lo emite la CA interna de la organización. El runbook de despliegue, respaldo y rotación de secretos se entrega en la Fase 9.

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
| `SESSION_*`, `ARGON2_*`, `RATE_LIMIT_*` | No | Con valores por defecto seguros |

## Verificación (`npm run check`)

```bash
npm run check
```

Ejecuta, en orden y deteniéndose en el primer fallo:

1. `npm ci`
2. Lint (ESLint con `eslint-plugin-security` en el backend y prohibición de sinks HTML en el frontend)
3. Secretos efímeros para el entorno de verificación
4. Construcción de imágenes y arranque del stack completo (proyecto Compose aparte, sin puertos publicados)
5. Tests unitarios, de integración y de seguridad dentro de un contenedor conectado a las redes internas, con cobertura mínima del 80 % en `backend/src/core`
6. `npm audit --audit-level=high` (raíz y backend)
7. gitleaks sobre el historial de Git
8. Trivy sobre las imágenes `backend`, `nginx` y `egress-proxy` (altas y críticas con corrección disponible)

No interfiere con un stack de desarrollo en ejecución: usa otro nombre de proyecto, otras subredes y otros secretos, y los borra al terminar. Necesita salida a internet (paquetes npm, base de Trivy y el test que verifica el túnel hacia Mandrill).

## Tests

- `backend/tests/unit`: configuración, logger, errores, health con dependencias simuladas.
- `backend/tests/integration`: health con PostgreSQL y Redis reales; permisos del usuario de base de datos y del usuario de Redis.
- `backend/tests/security`: inventario de rutas (deny by default), exposición de errores, proxy confiable, headers de nginx, TLS y control de egreso.

Los tests de integración y los del stack se ejecutan solo dentro de `npm run check`; fuera de él aparecen como omitidos.

## Estructura

```text
backend/            API y worker (Fastify, Node.js 26)
  src/core/         config, logging, errores, http, seguridad, db, redis, ciclo de vida
  src/modules/      un módulo por dominio (health en esta fase)
  tests/            unit, integration, security
frontend/           HTML + JS Vanilla (ES Modules), servido por nginx
proxy/              configuración de nginx y su Dockerfile
infra/              egress-proxy (Squid) y arranque de Redis con ACL
database/init/      creación de roles de PostgreSQL (una vez, al crear el volumen)
scripts/            generación de secretos y npm run check
spikes/mandrill/    scripts de exploración de la fase 0.5 (no son código de producción)
docs/               especificación, arquitectura, seguridad, ADR, OpenAPI
```
