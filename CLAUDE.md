# EnvioTec

Plataforma interna para enviar campañas de correo masivo con un PDF adjunto, a partir de plantillas Word con variables, con cuotas por usuario, aprobación de campañas y reportes. Envío mediante Mailchimp Transactional (Mandrill) vía API.

## Documentos que rigen el proyecto

Estos dos documentos son la especificación obligatoria. Se cargan completos en cada sesión:

@docs/baseline.md
@docs/project-spec.md

- `docs/baseline.md`: Parte A (baseline de seguridad, stack y arquitectura) y Parte C (metodología por fases). No se modifica sin mi aprobación explícita.
- `docs/project-spec.md`: Parte B (ficha de EnvioTec, controles específicos, usuarios locales y de AD, vigencia de cuentas, preguntas pendientes).

Si algo de la Parte B contradice la Parte A, detente, explica el conflicto y propón cómo resolverlo antes de seguir.

## Estado del proyecto

- **Fase actual:** 3 — Autenticación. Plan pendiente de aprobación.
- **En paralelo:** 0.5 — Spike de Mandrill, plan aprobado; en espera de una API key válida (`MANDRILL_API_KEY` como variable de entorno), remitente del subdominio verificado y buzón de prueba (erwin.villazon@gmail.com).
- **Fases aprobadas:** 2 — Base de datos y RBAC (2026-10-31; `npm run check` en verde, ADR-016 y ADR-017 aceptados). 1 — Base del proyecto (2026-10-31; `npm run check` en verde, ADR-015 aceptado). 0 — Análisis y modelo de amenazas (2026-10-31). Entregables: `docs/security.md`, `docs/architecture.md`, `docs/decisions/` (ADR 001–014, aceptados; 005 y 013 sujetos al spike) y Parte B actualizada.
- **Siguiente paso:** aprobación del plan de la Fase 3; después, implementarla.

Al cerrar y aprobarse cada fase, actualiza esta sección (fase actual, fases aprobadas, siguiente paso).

## Reglas de trabajo

- Una fase a la vez. Al terminar, presenta el checklist de Definition of Done (sección C1) y espera mi aprobación. Nunca avances de fase por tu cuenta.
- Antes de crear archivos en una fase nueva, muestra el plan de la fase y espera confirmación.
- Cada decisión de arquitectura relevante se registra como ADR en `docs/decisions/`.
- No agregues dependencias sin justificarlas (para qué, por qué no nativo, mantenimiento, licencia).
- Si un requisito es ambiguo, pregunta. No asumas.
- Si detectas que un requisito es inseguro o incorrecto, dilo y propón la corrección. No lo implementes en silencio.

## Reglas críticas (resumen; el detalle está en los documentos)

- Deny by default: toda ruta declara su permiso o se marca explícitamente como pública.
- El backend es la única frontera de seguridad; el frontend solo oculta o muestra.
- SQL solo en repositories y siempre parametrizado.
- Filtro por área obligatorio en cada consulta de datos de negocio.
- Frontend: prohibido `innerHTML` y similares con datos dinámicos; sin scripts inline.
- Auditoría append-only, protegida también a nivel de base de datos.
- Sin secretos en el código ni en Git; solo Docker secrets o variables de entorno.
- Cada usuario tiene un único origen de autenticación (local o AD).
- Los tests de seguridad se entregan en cada fase, no al final.

## Comandos

- `npm ci`: herramientas de lint en el host.
- `npm run secrets:dev`: genera `./secrets` (aleatorios) y un certificado autofirmado. `-- --force` los regenera (después, `docker compose down -v`).
- `docker compose up -d --build --wait`: stack de desarrollo (aplica `docker-compose.override.yml`).
- `docker compose -f docker-compose.yml up -d --build --wait`: stack de producción, sin override.
- `npm run lint`: ESLint.
- `npm run check`: npm ci, lint, stack aislado, tests con cobertura, npm audit, gitleaks y Trivy. Es lo que ejecutará Jenkins.
- `docker compose run --rm tools node scripts/migrate.js up` (también `down [n|all]` y `verify`): migraciones con `app_owner`.
- `docker compose run --rm tools node scripts/seed.js system` / `node scripts/seed.js dev`: catálogo de permisos, roles y parámetros / datos de desarrollo.
- `docker compose run --rm -it tools node scripts/bootstrap-admin.js` / `--emergency`: superadmin inicial / cuenta de emergencia.
