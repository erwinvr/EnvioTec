# Baseline — Fases, informe de hardening y Fase 0

> Parte de `docs/baseline.md` (baseline del prompt base), con la misma autoridad. No se modifica sin aprobación explícita.

## C1. Tabla de fases

| Fase | Entregables | Criterio de salida |
| --- | --- | --- |
| 0. Análisis y amenazas | Modelo de amenazas STRIDE (activos, actores, límites de confianza, amenazas y control asignado), preguntas pendientes de la Parte B, ADRs iniciales | Aprobado por mí |
| 1. Base del proyecto | Estructura, Docker Compose, config validada, logger con redacción, error handler, formato de respuesta, request ID, headers, health checks, `npm run check`, runner de tests | `docker compose up` levanta todo; `npm run check` en verde; un test de health pasa |
| 2. Base de datos y RBAC | Migraciones del núcleo, usuarios de BD con mínimo privilegio, seeds de permisos, bootstrap del superadmin, `requirePermission`, test de inventario de rutas | Matriz 401/403 pasa; `app_runtime` no puede alterar auditoría |
| 3. Autenticación | Login, logout, sesiones, CSRF, rate limiting, bloqueo, MFA, re-autenticación, cambio de contraseña, recuperación si aplica, proveedores de autenticación definidos en la Parte B | Tests de sesión, CSRF, enumeración y fuerza bruta pasan; revisión de seguridad de la fase |
| 4. Auditoría | Servicio de auditoría, encadenamiento por hash, trigger de protección, script de verificación, consulta y exportación | Todos los eventos obligatorios se registran; manipulación detectada |
| 5. Usuarios | ABM con listado paginado, búsqueda, filtros, orden, alta, edición, desactivación, asignación de roles | Tests de mass assignment, IDOR y anti-escalamiento pasan |
| 6. Roles y permisos | ABM de roles, asignación de permisos, vista de permisos efectivos, protecciones de roles de sistema | Reglas anti-escalamiento cubiertas al 100% |
| 7. Frontend del núcleo | Layout, navegación, login, MFA, dashboard, pantallas de usuarios, roles, permisos, auditoría, componentes reutilizables | Lint sin sinks peligrosos; CSP sin violaciones en consola |
| 8. Módulos de negocio | Un módulo de la Parte B por iteración, reutilizando el núcleo | Misma Definition of Done que el núcleo |
| 9. Hardening | Revisión contra ASVS nivel 2, escaneo de dependencias e imagen, revisión de configuración de producción, runbook de despliegue y respaldos | Informe de seguridad sin hallazgos altos ni críticos abiertos |

## C1. Cierre del proyecto

**Informe de hardening (fase 9)** en formato tabla: Hallazgo · Requisito ASVS · Severidad · Impacto · Archivo · Corrección · Estado.

**Documentación entregable al cierre:** README (descripción, arquitectura, requisitos, instalación, variables de entorno, ejecución local y con Docker, migraciones, seeds, tests, estructura), especificación OpenAPI de todos los endpoints, `security.md` con el modelo de amenazas y los controles, ADRs y un runbook de operación (despliegue, respaldo y restauración de PostgreSQL, rotación de secretos, revocación masiva de sesiones).

## C3. Primera respuesta (Fase 0)

En la primera respuesta **no generes código**. Entrega solo la Fase 0:

1. Preguntas sobre campos vacíos, ambiguos o `PENDIENTE` de la Parte B.
2. Conflictos detectados entre la Parte B y la Parte A.
3. Modelo de amenazas STRIDE del proyecto.
4. Arquitectura confirmada y cualquier ajuste propuesto, con justificación.
5. Modelo de datos del núcleo más las entidades de negocio de la Parte B.
6. Catálogo completo de permisos (núcleo y negocio) y roles iniciales propuestos.
7. Lista de dependencias con justificación.
8. Riesgos técnicos a resolver antes de empezar.
9. Plan de fases ajustado al proyecto.

Después **espera mi aprobación** para empezar la Fase 1. A partir de ahí, trabaja una fase a la vez y no avances automáticamente.

La prioridad absoluta es una aplicación **segura, profesional, mantenible y realmente ejecutable**, no una gran cantidad de código.
