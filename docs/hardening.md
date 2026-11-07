# EnvioTec — Informe de hardening (Fase 9)

- **Fecha:** 2026-11-01
- **Estándar:** OWASP ASVS 5.0, nivel 2 (A1). El OWASP Top 10 se usa como lista de riesgos.
- **Alcance:** núcleo (Fases 1–7) y módulos de negocio (8.1–8.6), configuración de producción (`docker-compose.yml`, `proxy/`, `infra/`) y cadena de suministro.
- **Método:**
  - revisión de cada capítulo de ASVS contra el código y el modelo de amenazas (`security.md`, sección 4);
  - `npm run check`: lint con reglas de seguridad, 31 tests de base de datos, más de 550 tests de backend con cobertura, navegador real con CSP estricta, verificación de la cadena de auditoría, `npm audit --audit-level=high`, gitleaks y Trivy sobre las seis imágenes.

**Resultado:** sin hallazgos altos ni críticos abiertos. Los abiertos son de severidad media o baja y dependen de recursos externos: API key de Mandrill, AD de la organización y DNS.

## 1. Hallazgos

| # | Hallazgo | Requisito ASVS | Severidad | Impacto | Archivo | Corrección | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | La anonimización a pedido del contacto no borraba sus datos en `campaign_recipients` (tabla de la 8.4), y un destinatario pendiente se habría enviado al seudónimo | V14.2 (protección de datos personales) | Alta | Datos personales retenidos después de una solicitud de borrado | `backend/src/modules/suppressions/suppressions.repository.js` | La anonimización también limpia las copias en campañas y suprime los pendientes; test en `sending.test.js` | Corregido (8.5) |
| H17 | `areas.view_all` también habilitaba escribir: un operador o aprobador con el rol `reportes` creaba, modificaba o aprobaba en cualquier área (detectado por el usuario en pruebas) | V8.2 (autorización a nivel de objeto) | Alta | Datos de negocio y aprobación de campañas fuera del área; maker-checker sin límite de área | `backend/src/core/authorization/area-scope.js` y servicios de plantillas, contactos y campañas | Alcance de escritura siempre en el área propia (`writeScopeFor`); 403 auditado; pausar y cancelar como excepción; tests en `area-write-scope.test.js`. ADR-026 | Corregido (2026-11-03) |
| H18 | Un borrador que ya usaba una plantilla archivada podía enviarse a aprobación; una plantilla archivada no se podía recuperar desde la interfaz | V2.1 (reglas de negocio) | Baja | Campañas con contenido retirado de uso | `backend/src/modules/campaigns/campaign-rules.js`, `frontend/src/pages/templates/` | Envío a aprobación rechazado (`template_archived`); filtro "Mostrar archivadas" y botón *Desarchivar*, auditado como `template.unarchive`; tests | Corregido (2026-11-03) |
| H19 | Carrera en el router del frontend: una pantalla lenta que terminaba de cargar después podía escribir encima de la siguiente (detectado por el e2e) | V15.1 | Baja | El usuario ve la pantalla equivocada al navegar rápido | `frontend/src/app.js` | Cada pantalla se dibuja en un contenedor propio que se muestra solo si sigue siendo la vigente | Corregido (2026-11-07) |
| H20 | Imagen de nginx con 7 CVE altas nuevas en libexpat, musl y zlib de la base Alpine (Trivy) | V15.2 (componentes con vulnerabilidades) | Alta | DoS o ejecución de código en el proxy de borde | `proxy/Dockerfile` | `apk upgrade` de los paquetes afectados hasta que la imagen base los incluya; Trivy en 0 | Corregido (2026-11-07) |
| H2 | `messages/search` devuelve como máximo 1000 resultados: en campañas más grandes se perdían eventos | V15.1 (comportamiento ante límites de dependencias) | Media | Reportes incompletos y bajas o rebotes no suprimidos | `backend/src/modules/sending/sync.service.js` | Al llegar al límite, búsqueda lote por lote (100 mensajes cada uno); test | Corregido (8.5) |
| H3 | `request_id` de los trabajos del worker superaba los 64 caracteres del CHECK de auditoría: la conciliación de un lote fallaba | V16.3 (registro de eventos de seguridad) | Media | Un lote ambiguo no se cerraba (fallaba de forma segura: no reenviaba) | `backend/src/modules/sending/sender.service.js` | Identificador acotado a 64 caracteres; test de conciliación | Corregido (8.5) |
| H4 | `DATA_ENCRYPTION_KEY` sin procedimiento de rotación: cambiarla invalidaba todos los MFA | V11.1 (gestión del ciclo de vida de claves) | Media | Ante una filtración no se podía rotar sin reenrolar a todos | `database/scripts/rotate-encryption-key.js` | Script de rotación atómica y auditada; test; runbook, sección 5 | Corregido (9) |
| H5 | Sin procedimiento de revocación masiva de sesiones | V7.4 (terminación de sesiones) | Media | Respuesta lenta ante un incidente | `database/scripts/revoke-sessions.js` | Script auditado (todas o de un usuario); test; runbook, sección 6 | Corregido (9) |
| H6 | Logs de contenedores sin rotación (driver `json-file` por defecto) | V16.4 (protección de logs), V13.1 | Media | El disco se llena (DoS) y no hay retención controlada | `docker-compose.yml` | `max-size` y `max-file` en todos los servicios; envío al sistema central (runbook, sección 7) | Corregido (9) |
| H7 | Reintento de lotes sin backoff exponencial (T34): siempre cada 5 minutos | V15.2 (uso de recursos ante fallos de dependencias) | Baja | Más llamadas al proveedor mientras está degradado | `backend/src/modules/sending/sending.repository.js` | Backoff de 5, 10, 20, 40 y 60 minutos según los intentos; test | Corregido (9) |
| H8 | Los valores HTML de las variables conservaban caracteres de control | V1.2 (codificación de salida) | Baja | Contenido raro en el correo; sin ejecución | `backend/src/modules/sending/message.js` | Limpieza igual a la del texto plano; test | Corregido (8.5) |
| H9 | Rutas duplicadas y páginas de plantillas sin uso en el frontend (restos de una sesión anterior) | V15.1 (código mantenible y sin superficie muerta) | Baja | Confusión en el mantenimiento; superficie innecesaria | `frontend/src/routes.js`, `frontend/src/pages/templates/` | Duplicados y páginas muertas eliminados | Corregido (8.6) |
| H10 | Las exportaciones no tienen límite de filas, aunque T23 lo mencionaba | V8.1, V14.2 | Baja | Una cuenta tomada exporta una lista o campaña completa | `backend/src/modules/contacts`, `backend/src/modules/reports` | Se mantiene sin límite: el volumen ya está acotado por la lista o la campaña, y cada exportación exige permiso, respeta el área, enmascara sin `contacts.view` y se audita. Se documenta como riesgo aceptado junto a RA1 | Aceptado (RA1, ADR-014) |
| H11 | Proveedor LDAPS no validado contra el AD real (R15) | V6.8 (proveedores de identidad) | Media | Diferencias de atributos, grupos anidados o TLS con la CA interna | `backend/src/core/auth/providers/ad.provider.js` | Lista de validación en el runbook, sección 9 | Abierto (requiere el AD de la organización) |
| H12 | Red hacia el controlador de dominio no definida en compose (R17) | V13.2 (segmentación de red) | Media | Sin ella, AD no funciona en producción; si se abriera de más, saldría tráfico no permitido | `docker-compose.yml` | Red `directory` con firewall solo hacia el puerto 636 (runbook, sección 8) | Abierto (se define al desplegar) |
| H13 | Comportamiento real de Mandrill sin verificar: escape del merge (R6), `_id` por destinatario (R2), búsqueda por metadata (R1, R3) y baja con un clic (R4) | V12.3, V1.3, V15.1 | Media | Doble escape o falta de escape en el correo, eventos sin cruzar, entregabilidad | `backend/src/modules/sending/` | Spike 0.5 con la API key y el buzón de prueba (runbook, sección 10). Hasta entonces el worker no envía | Abierto (bloqueado por la API key) |
| H14 | Correo del sistema deshabilitado sin la key de sistema (R16): no hay recuperación por correo ni avisos de vigencia o de tope global | V6.4 (recuperación de credenciales) | Baja | Los usuarios locales dependen del reset por administrador | `backend/src/core/mail/mailer.js` | Configurar `MANDRILL_SYSTEM_API_KEY` y `MAIL_FROM` en la puesta en marcha | Abierto (configuración) |
| H15 | SPF, DKIM y DMARC del subdominio de envío (R13) | — (requisito de remitentes masivos) | Media | Correos rechazados o marcados como spam; suplantación del dominio | DNS de la organización | Runbook, sección 10, paso 1 | Abierto (fuera del código) |
| H16 | Cifras de reportes calculadas en cada consulta (ADR-025) | V15.2 | Info | Lentitud con campañas muy grandes | `backend/src/modules/reports/reports.repository.js` | Medir con volumen real; materializar si hace falta sin cambiar la API | Abierto (seguimiento) |

## 2. Revisión por capítulo de ASVS 5.0 (nivel 2)

| Capítulo | Controles en EnvioTec | Evidencia | Pendiente |
| --- | --- | --- | --- |
| V1 Codificación y sanitización | Sin sinks HTML en el frontend (ESLint los prohíbe); HTML de plantillas sanitizado con allowlist; variables escapadas una vez y sin lógica; neutralización de CSV injection; filtros LDAP escapados (RFC 4515); SQL solo parametrizado | `npm run lint`, `unit/templates`, `unit/sending`, `reports.test.js` | H13 (R6) |
| V2 Validación y lógica de negocio | Schemas con `additionalProperties: false`; maker-checker en el servicio y en la base; cuotas con bloqueo de fila; tope global; envíos de prueba limitados; supresión sin excepciones | `campaigns.test.js`, `senders-quotas.test.js`, `sending.test.js` | — |
| V3 Seguridad del frontend web | CSP estricta sin `unsafe-*`, Trusted Types, mismo origen sin CORS, cookies `__Host-` con `SameSite=Strict`, vista previa en `iframe sandbox` con CSP propia | `e2e/run.mjs` (sin violaciones), `security/headers` | — |
| V4 API y servicios web | Formato de respuesta único, schemas de salida en cada ruta, paginación con máximo 100, OpenAPI | `authorization-matrix.test.js`, `docs/openapi.yaml` | — |
| V5 Manejo de archivos | Pipeline aislado sin base de datos ni internet; ClamAV; validación por contenido; límites de tamaño, de compresión y de filas; qpdf; nombres UUID fuera del webroot | `contacts.test.js`, `templates.test.js`, `campaigns.test.js` | — |
| V6 Autenticación | Argon2id, política NIST, bloqueo progresivo, sin enumeración, MFA TOTP para administración y campañas, enrolamiento de AD por código, LDAPS con validación de certificado | `auth-*.test.js` | H11, H14 |
| V7 Sesiones | Token opaco de 256 bits (hash en la base), regeneración, timeouts por inactividad y absoluto, revocación al cambiar contraseña o roles, revocación masiva | `auth-login.test.js`, `operations.test.js` | — |
| V8 Autorización | Deny by default (ruta sin permiso = error de arranque), matriz 401/403/éxito de todas las rutas, alcance por área en cada repository (IDOR → 404), seis reglas contra escalamiento al 100 % | `authorization-matrix.test.js`, `roles-admin.test.js` | — |
| V9 / V10 Tokens y OAuth | No aplica: no hay JWT ni OAuth (A5) | — | — |
| V11 Criptografía | AES-256-GCM con AAD por dueño para los secretos MFA; SHA-256 para tokens y hashes de supresión; aleatoriedad de `crypto.randomBytes`; rotación de la clave de datos | `unit/encryption`, `operations.test.js` | — |
| V12 Comunicación segura | TLS 1.2 y 1.3 en el proxy con HSTS; LDAPS; HTTPS hacia Mandrill a través del proxy de egreso | `proxy/default.conf`, `unit/config.test.js` | H13 |
| V13 Configuración | Configuración validada al arrancar (la app no arranca con secretos débiles); Docker secrets; contenedores `read_only`, `cap_drop: ALL`, `no-new-privileges`, no root, con límites de CPU y memoria; redes internas; proxy de egreso con allowlist; imágenes fijadas por digest | `docker-compose.yml`, Trivy, gitleaks | H12 |
| V14 Protección de datos | Enmascarado sin `contacts.view` (también al exportar); anonimización con seudónimo; reportes por contacto sin la dirección en la URL; `Cache-Control: no-store` en la API | `contacts.test.js`, `reports.test.js` | H10 aceptado |
| V15 Codificación segura y arquitectura | Capas Route → Controller → Service → Repository; dependencias justificadas con versiones exactas; `npm audit`; idempotencia y conciliación en el envío | `npm run check` | H16 |
| V16 Registro y manejo de errores | Auditoría append-only con trigger y cadena de hash verificable; todo 403 auditado; error handler sin detalles internos; Pino con redacción; logs con rotación | `audit-logs.test.js`, `audit-verify` | — |
| V17 WebRTC | No aplica | — | — |

## 3. Cadena de suministro

- **Dependencias:** versiones exactas y `package-lock.json` versionado. `npm audit --audit-level=high` sin hallazgos en la última ejecución.
- **Imágenes base:** fijadas por digest. Trivy no encuentra vulnerabilidades altas ni críticas con corrección disponible en `backend`, `file-processor`, `nginx`, `egress-proxy` y `tools`.
- **Secretos:** gitleaks sin hallazgos en el historial.
- **Pendiente sin CI:** configurar Dependabot o Renovate cuando el repositorio esté en un servidor Git que lo permita (A11). Mientras tanto, `npm run check` lo cubre en cada entrega.

## 4. Decisiones tomadas con la autorización general del 2026-10-31

Quedan para la revisión del responsable del proyecto. Cada una tiene su ADR en estado *Propuesto*:

| ADR | Decisión | Por revisar |
| --- | --- | --- |
| ADR-022 | Pipeline de archivos aislado: colas, ACL de Redis, volumen y ClamAV | Recursos de ClamAV (2 GB de memoria) |
| ADR-023 | Campañas: área de la lista, estados, maker-checker en dos capas, `campaign_recipients` sin particionar | Que una campaña con envíos de prueba no se pueda borrar, solo cancelar |
| ADR-024 | Envío y sincronización: lotes de 100, escape con triple llave, devolución de cuota, conciliación, polling cada 10 minutos | Confirmación en el spike 0.5 |
| ADR-025 | Reportes: definiciones de entregado y abierto, cálculo al leer, enmascarado también al exportar, búsqueda por contacto por `POST` y auditada | Definiciones de las métricas con el negocio |
| Fase 9 | Rotación de la clave de datos, revocación masiva, rotación de logs y backoff exponencial | — |
