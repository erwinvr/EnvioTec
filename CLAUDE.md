# EnvioTec

Plataforma interna para enviar campañas de correo masivo con un PDF adjunto, a partir de plantillas Word con variables, con cuotas por usuario, aprobación de campañas y reportes. Envío mediante Mailchimp Transactional (Mandrill) vía API.

## Documentos que rigen el proyecto

Estos dos documentos son la especificación obligatoria. Se cargan completos en cada sesión:

@docs/baseline.md
@docs/project-spec.md

- `docs/baseline.md`: núcleo de la Parte A y la Parte C; el detalle está en `docs/baseline/*.md`, que tienen la misma autoridad y se leen según la tabla de punteros. Ninguno se modifica sin mi aprobación explícita.
- `docs/project-spec.md`: Parte B (ficha de EnvioTec, controles específicos, usuarios locales y de AD, vigencia de cuentas, preguntas pendientes).

Si algo de la Parte B contradice la Parte A, detente, explica el conflicto y propón cómo resolverlo antes de seguir.

## Estado del proyecto

- **Fase actual:** 8 — Módulos de negocio. 8.1 a 8.6 entregadas. Fase 9 (hardening) entregada; todo lo autorizado el 2026-10-31 está terminado y pendiente de la revisión final del usuario. El 2026-10-31 el usuario aprobó todo lo restante ("apruebo todo, confío en ti, termina todo"): se avanza iteración por iteración sin esperar aprobación, registrando cada decisión en ADR y en `docs/security.md` para su revisión final.
- **En paralelo:** 0.5 — Spike de Mandrill, plan aprobado; en espera de una API key válida (`MANDRILL_API_KEY` como variable de entorno), remitente del subdominio verificado y buzón de prueba (erwin.villazon@gmail.com).
- **Fases aprobadas:** 9 — Hardening (2026-11-01; informe ASVS L2 sin hallazgos altos ni críticos abiertos, runbook, rotación de clave y revocación masiva). 8.6 — Reportes (2026-11-01; cifras por campaña y por contacto, enmascarado también al exportar, ADR-025). 8.5 — Envío y sincronización (2026-11-01; Mandrill simulado en proceso, lotes con conciliación, devolución de cuota, ADR-024; sujeto al spike 0.5). 8.4 — Campañas (2026-11-01; PDF con qpdf y ClamAV, maker-checker, ADR-023). 8.3 — Plantillas (2026-11-01; .docx inspeccionado, vista previa aislada). 8.2 — Contactos y supresión (2026-11-01; pipeline de archivos aislado con ClamAV, ADR-022). 8.1 — Remitentes y cuotas (2026-10-31; dominios de envío y de Reply-To sin definir, parámetros vacíos). 7 — Frontend del núcleo (2026-10-31; `npm run check` en verde con navegador real, ADR-021 aceptado). 6 — Roles y permisos (2026-10-31; `npm run check` en verde, reglas contra escalamiento al 100 %). 5 — Usuarios (2026-10-31; `npm run check` en verde, ADR-020 aceptado; cuenta de emergencia exenta también de inactividad). 4 — Auditoría (2026-10-31; `npm run check` en verde, 11 pasos; R12 resuelto). 3 — Autenticación (2026-10-31; `npm run check` en verde, ADR-018 y ADR-019 aceptados; pendientes R15 AD real, R16 key de sistema de Mandrill, R17 red al controlador de dominio). 2 — Base de datos y RBAC (2026-10-31; `npm run check` en verde, ADR-016 y ADR-017 aceptados). 1 — Base del proyecto (2026-10-31; `npm run check` en verde, ADR-015 aceptado). 0 — Análisis y modelo de amenazas (2026-10-31). Entregables: `docs/security.md`, `docs/architecture.md`, `docs/decisions/` (ADR 001–014, aceptados; 005 y 013 sujetos al spike) y Parte B actualizada.
- **Siguiente paso:** revisión final del usuario (ADR-022 a ADR-025 en estado Propuesto, `docs/hardening.md`); spike 0.5 con la API key de Mandrill; validación con el AD real (runbook, secciones 8 a 10).

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
- `npm run test:frontend`: tests del frontend sin navegador.
- `npm run check`: npm ci, lint, stack aislado, tests con cobertura, npm audit, gitleaks y Trivy. Es lo que ejecutará Jenkins.
- `docker compose run --rm tools node scripts/migrate.js up` (también `down [n|all]` y `verify`): migraciones con `app_owner`.
- `docker compose run --rm tools node scripts/seed.js system` / `node scripts/seed.js dev`: catálogo de permisos, roles y parámetros / datos de desarrollo.
- `docker compose run --rm -it tools node scripts/bootstrap-admin.js` / `--emergency`: superadmin inicial / cuenta de emergencia.
- `docker compose run --rm tools node scripts/audit-verify.js [--from <fecha>]`: verificación de la cadena de auditoría.
- `docker compose run --rm tools node scripts/revoke-sessions.js --reason "<motivo>" [--user <uuid>]` / `scripts/rotate-encryption-key.js --old <archivo> --new <archivo>`: revocación masiva de sesiones / rotación de `DATA_ENCRYPTION_KEY` (ver `docs/runbook.md`).
