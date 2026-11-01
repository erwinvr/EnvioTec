# Registro de decisiones de arquitectura (ADR)

Cada decisión de arquitectura relevante se registra aquí con contexto, decisión, alternativas descartadas y consecuencias. Un ADR aceptado no se edita: si la decisión cambia, se escribe uno nuevo que lo reemplaza.

| ADR | Título | Estado |
| --- | --- | --- |
| [001](001-nginx-proxy-de-borde.md) | Nginx como proxy de borde | Aceptado |
| [002](002-sesiones-server-side.md) | Sesiones server-side en PostgreSQL, sin JWT | Aceptado |
| [003](003-bullmq-y-redis.md) | Worker con BullMQ y Redis con `noeviction` + AOF | Aceptado |
| [004](004-pipeline-aislado-de-archivos.md) | Pipeline aislado de archivos | Aceptado |
| [005](005-mandrill-lotes-y-polling.md) | Mandrill: envío por lotes y estado por polling | Aceptado (sujeto al spike) |
| [006](006-proveedores-de-autenticacion.md) | Proveedores de autenticación local y AD | Aceptado |
| [007](007-roles-desde-ad.md) | Grupos de AD solo para roles de negocio | Aceptado |
| [008](008-alcance-por-area.md) | Alcance por área y 404 para objetos de otra área | Aceptado |
| [009](009-proxy-de-egreso.md) | Egreso por proxy con allowlist de dominios | Aceptado |
| [010](010-postgresql-18-uuidv7-particiones.md) | PostgreSQL 18, UUIDv7 y particionado mensual | Aceptado |
| [011](011-foto-de-destinatarios-y-cuotas.md) | Foto de destinatarios, cuotas y tope global | Aceptado |
| [012](012-vista-previa-aislada.md) | Vista previa aislada con CSP propia | Aceptado |
| [013](013-variables-y-merge.md) | Lenguaje de merge y escape de variables | Aceptado (sujeto al spike) |
| [014](014-riesgos-aceptados.md) | Riesgos aceptados por el negocio | Aceptado |
| [015](015-squid-como-proxy-de-egreso.md) | Squid como proxy de egreso | Aceptado |
| [016](016-argon2-nativo-y-politica-de-contrasenas.md) | Argon2id nativo y política de contraseñas | Aceptado |
| [017](017-imagen-tools-y-migraciones.md) | Imagen tools para migraciones, seeds y bootstrap | Aceptado |
| [018](018-etapas-de-sesion-y-rutas-autenticadas.md) | Etapas de la sesión, rutas autenticadas y auditoría desde la Fase 3 | Aceptado |
| [019](019-pruebas-de-ad-con-directorio-simulado.md) | Pruebas de AD con directorio simulado | Aceptado |
| [020](020-programador-de-trabajos-del-worker.md) | Programador de trabajos periódicos del worker | Aceptado |
