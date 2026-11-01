# EnvioTec — Modelo de amenazas y controles

Estado: Fase 0 aprobada (2026-10-31).

Este documento contiene el modelo de amenazas STRIDE de EnvioTec y el control asignado a cada amenaza. Se actualiza al cerrar cada fase con la revisión de seguridad de la fase (qué amenazas cubre y cuáles quedan pendientes).

Estándar de verificación: OWASP ASVS 5.0, nivel 2. Las referencias van a nivel de capítulo:

| Capítulo | Tema |
| --- | --- |
| V1 | Codificación y sanitización |
| V2 | Validación y lógica de negocio |
| V3 | Seguridad del frontend web |
| V4 | API y servicios web |
| V5 | Manejo de archivos |
| V6 | Autenticación |
| V7 | Gestión de sesiones |
| V8 | Autorización |
| V11 | Criptografía |
| V12 | Comunicación segura |
| V13 | Configuración |
| V14 | Protección de datos |
| V15 | Código y arquitectura seguros |
| V16 | Registro de seguridad y manejo de errores |

El mapeo a requisitos individuales se agrega en la revisión de seguridad de cada fase.

## 1. Activos

| ID | Activo | Criticidad |
| --- | --- | --- |
| A1 | Reputación del dominio de envío y de la cuenta de Mailchimp | Crítica |
| A2 | Datos personales de los contactos (nombre, email, variables) | Alta |
| A3 | PDFs adjuntos (sin datos sensibles; riesgo de distribuir malware) | Alta |
| A4 | API keys de Mandrill (campañas y sistema) | Crítica |
| A5 | Credencial de la cuenta de servicio de AD | Alta |
| A6 | Sesiones, hashes de contraseñas, secretos TOTP, `DATA_ENCRYPTION_KEY`, `CSRF_SECRET` | Crítica |
| A7 | Auditoría | Alta |
| A8 | Cuotas, tope global y flujo de aprobación | Alta |
| A9 | Plantillas (definen lo que se envía en nombre de la empresa) | Alta |
| A10 | Parámetros del sistema | Media |

## 2. Actores

| Actor | Descripción |
| --- | --- |
| Anónimo interno | Cualquier equipo de la red de la organización |
| Operador | Usuario legítimo que puede actuar con mala intención o tener la cuenta tomada |
| Aprobador | Puede actuar en complicidad con un operador |
| Administrador | Siempre cuenta local; puede actuar con mala intención |
| Administrador de AD | Fuera de la app; controla grupos y el atributo `department` |
| Autor de un archivo malicioso | Quien sube un .docx, CSV o PDF manipulado, con o sin intención |
| Destinatario | Interno o externo; recibe el correo e interactúa con el píxel, los enlaces y la baja |
| Mandrill | Tercero; sus respuestas no son confiables |
| Operador de infraestructura | Acceso al host y a los Docker secrets |

## 3. Límites de confianza

| ID | Límite |
| --- | --- |
| TB1 | Navegador ↔ Nginx (HTTPS, certificado de la CA interna) |
| TB2 | Nginx ↔ backend (red `edge`) |
| TB3 | Backend y worker ↔ PostgreSQL y Redis (red `data`) |
| TB4 | Worker ↔ procesador de archivos y ClamAV (red `files`, interna; contenido no confiable) |
| TB5 | Worker y backend ↔ Mandrill (internet, por el proxy de egreso) |
| TB6 | Backend y worker ↔ controlador de dominio (LDAPS) |
| TB7 | Mandrill ↔ destinatarios (píxel, clics y baja fuera de nuestro control) |
| TB8 | Host ↔ Docker secrets |

```text
Navegador ──TB1──▶ Nginx ──TB2──▶ Backend ──TB3──▶ PostgreSQL / Redis
                                    │  ▲
                                    │  └──TB3── Worker ──TB4──▶ file-processor, ClamAV
                                    │             │
                                    └──TB6──▶ AD  └──TB5──▶ egress-proxy ──▶ Mandrill ──TB7──▶ Destinatarios
                                                                  └──────▶ firmas ClamAV (freshclam)
```

## 4. Amenazas y controles

| ID | STRIDE | Amenaza | Control asignado | ASVS | Fase |
| --- | --- | --- | --- | --- | --- |
| T1 | S | Fuerza bruta o credential stuffing en el login | Rate limiting por IP y por cuenta en Redis, bloqueo progresivo, MFA | V6 | 3 |
| T2 | S | Enumeración de usuarios en login o recuperación, incluso distinguiendo cuentas locales de AD | Respuesta, código y tiempo uniformes (hash ficticio); la recuperación de una cuenta de AD responde igual que la de una inexistente | V6 | 3 |
| T3 | S | Bind LDAP sin autenticar: contraseña vacía aceptada por AD | Rechazar contraseñas vacías antes de llamar a AD; bind con el DN del usuario y su contraseña, nunca bind anónimo | V6 | 3 |
| T4 | S/T | Inyección en filtros LDAP | Escape según RFC 4515 y validación del formato de username antes de buscar | V1 | 3 |
| T5 | S | Interceptación de LDAP (MITM) | Solo LDAPS o StartTLS, validando el certificado contra la CA interna (montada como secret) | V12 | 3 |
| T6 | S | Robo de la cuenta de un aprobador u operador para enviar phishing con el dominio de la empresa | MFA obligatorio para `campaigns.submit` y `campaigns.approve`, re-autenticación al aprobar, aprobación obligatoria, auditoría | V6, V2 | 3, 8 |
| T7 | S | Toma del MFA en el primer login de una cuenta de AD creada por JIT: quien conoce la contraseña de AD enrola su propio dispositivo | Código de enrolamiento de un solo uso, emitido por un administrador (`users.reset_mfa`, re-autenticación), guardado como hash, ligado al usuario, con vencimiento corto y entregado por otro canal. Sin código no se puede configurar el MFA ni usar la cuenta (ADR-006) | V6 | 3 |
| T8 | S | Fijación o secuestro de sesión | Cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`; regeneración del token; timeouts; revocación | V7 | 3 |
| T9 | S | Suplantación del remitente (por ejemplo, hacerse pasar por la gerencia) | From y Reply-To solo desde la lista permitida del área (`senders.manage`) | V2 | 8 |
| T10 | T | CSRF | `SameSite=Strict`, synchronizer token en `X-CSRF-Token`, verificación de `Origin` | V3 | 3 |
| T11 | T | Mass assignment (`status`, `area_id`, `approved_by`, saldos, `auth_source`) | Schemas con `additionalProperties: false`; el service copia solo campos permitidos | V2, V15 | todas |
| T12 | T | Cambiar el contenido de una campaña ya aprobada | La aprobación fija versión de plantilla, hash del PDF, lista y remitente. Editar una campaña aprobada o programada la devuelve a borrador, libera la cuota y exige nueva aprobación; enviando o en pausa no se edita. El worker envía solo la foto aprobada | V2 | 8 |
| T13 | T | Carrera en la cuota o en el tope global: dos aprobaciones o envíos simultáneos superan el saldo | Transacción con `SELECT … FOR UPDATE` sobre el saldo del usuario y el contador mensual; CHECK `reserved + consumed <= assigned` | V2 | 8 |
| T14 | T | Un usuario modifica su propio saldo de cuota | Regla en el service: `quotas.manage` no aplica sobre uno mismo; test | V8 | 8 |
| T15 | T | Alteración de la auditoría | `app_runtime` solo con `INSERT`/`SELECT`; trigger que rechaza `UPDATE`/`DELETE`; cadena de hash con advisory lock; script de verificación | V16 | 2, 4 |
| T16 | T | Plantilla con XSS que llega a la app | Sanitización con allowlist en el servidor; vista previa en `iframe sandbox` desde una ruta con CSP propia; sin sinks HTML en el frontend | V1, V3 | 8 |
| T17 | T | Inyección por variables: un valor del contacto inserta HTML o código | Allowlist de variables; escape HTML de cada valor; lenguaje de merge sin lógica (ADR-013) | V1 | 8 |
| T18 | T | Inyección de cabeceras de correo (CRLF) en asunto o nombre del remitente | Rechazo de caracteres de control; envío por API JSON, no SMTP | V1 | 8 |
| T19 | T | Respuesta de Mandrill malformada o maliciosa | Validación por schema y límite de tamaño de cada respuesta | V4 | 8 |
| T20 | R | Un usuario niega haber enviado, aprobado o cancelado | Auditoría con actor, sesión, IP y `request_id`; SHA-256 del PDF y versión de la plantilla en la campaña | V16 | 4, 8 |
| T21 | R | Cambios de parámetros, vigencias o cuotas sin rastro | Auditoría con valor anterior y nuevo; motivo obligatorio en renovaciones y ajustes de cuota | V16 | 5, 8 |
| T22 | I | IDOR entre áreas | Filtro por `area_id` en cada consulta del repository; objeto de otra área → 404 auditado como `denied`; tests por endpoint | V8 | 5, 8 |
| T23 | I | Exportación masiva de datos personales | Permisos `contacts.export` / `reports.export`, alcance por área, auditoría de cada exportación, límite de filas. Sin MFA: riesgo aceptado (ADR-014) | V8, V14 | 8 |
| T24 | I | CSV injection en exportaciones | Prefijo `'` en celdas que empiezan con `=`, `+`, `-`, `@`, tabulador o retorno de carro | V1 | 8 |
| T25 | I | Archivos accesibles desde la web | Volumen privado, nombre generado por el servidor (UUID), descarga autenticada con `Content-Disposition: attachment` | V5 | 8 |
| T26 | I | Secretos en logs, código o Git | Redacción en Pino, Docker secrets, gitleaks en `npm run check` | V13, V16 | 1 |
| T27 | I | El .docx carga recursos externos (plantilla remota, imágenes enlazadas) | Rechazo de relaciones `TargetMode="External"`, `altChunk` y `attachedTemplate`; el procesador no tiene salida de red | V5 | 8 |
| T28 | I | XXE en el XML del .docx | Parser sin DTD ni entidades externas; rechazo de cualquier `<!DOCTYPE` | V5 | 8 |
| T29 | I | Detalles internos en errores | Error handler central: mensaje genérico y `request_id` | V16 | 1 |
| T30 | D | Bomba ZIP en el .docx | Inspección del directorio central antes de descomprimir: tamaño total, número de entradas y razón de compresión | V5 | 8 |
| T31 | D | PDF o CSV enorme o malformado | Límite de bytes en multipart (PDF 5 MB), límite de filas, streaming, timeout por trabajo | V5 | 8 |
| T32 | D | Bloqueo de cuentas de AD (umbral de 3) causado desde EnvioTec | Corte a los 2 intentos fallidos por cuenta de AD con bloqueo de 15 minutos (ventana de AD); rate limiting por IP | V6 | 3 |
| T33 | D | Una campaña grande acapara el worker | Colas separadas (envío, sincronización, archivos, mantenimiento), concurrencia limitada, envío por lotes | V15 | 8 |
| T34 | D | Límites del proveedor o del plan agotados | Respeto de límites de Mandrill con backoff exponencial y jitter; tope global mensual que pausa campañas | V15 | 8 |
| T35 | E | Escalamiento de privilegios por roles o permisos | Las seis reglas de A6; roles administrativos solo en cuentas locales (trigger en BD); grupos de AD mapeados solo a roles de negocio | V8 | 6 |
| T36 | E | Saltarse la aprobación con envíos de prueba | Solo al propio correo o a dominios internos permitidos; máximo 5 por usuario por día; descuentan cuota | V2 | 8 |
| T37 | E | Un aprobador aprueba su propia campaña | Regla en el service y CHECK `approved_by <> submitted_by` en la BD | V2, V8 | 8 |
| T38 | E | Ejecución de código vía PDF, .docx o el propio procesamiento | Procesador aislado (sin BD ni internet, `read_only`, `cap_drop: ALL`); rechazo de `.docm` y `vbaProject.bin`; PDF normalizado con qpdf y rechazo de `/JS`, `/JavaScript`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA` y cifrado; ClamAV | V5 | 8 |
| T39 | E | Envío a contactos dados de baja | Supresión global aplicada en la consulta de envío del worker, sin parámetro para saltarla; Mandrill aplica además su lista de rechazos | V2 | 8 |
| T40 | E | Contenedor comprometido que sale a internet | Proxy de egreso con allowlist de dominios; redes Docker separadas | V13 | 1, 9 |
| T41 | S | Cuenta de AD dada de baja que sigue con sesión activa | Revisión de AD cada 15 minutos por el worker con revocación de sesiones; revisión en login y re-autenticación | V7 | 3, 5 |
| T42 | E | Administrador de AD asigna un `department` para ganar acceso a otra área | Solo áreas con `ad_department` explícito; el cambio de área detectado se audita y revoca sesiones | V8 | 5 |
| T43 | E/T | Procesador de archivos comprometido que usa Redis para encolar trabajos de envío o alterar contadores | Usuario ACL de Redis para el procesador limitado a las claves de su cola; los trabajos de envío solo llevan IDs y el worker verifica en PostgreSQL que la campaña esté aprobada antes de enviar | V13, V15 | 1, 8 |

## 5. Riesgos aceptados

Decisiones del negocio que dejan un riesgo residual. Cada una tiene su ADR.

| ID | Riesgo | Decisión | ADR |
| --- | --- | --- | --- |
| RA1 | Exportación masiva de contactos o reportes con una cuenta tomada que no tiene MFA | No se exige MFA para `contacts.export` ni `reports.export` | ADR-014 |
| RA2 | Eventos tardíos (aperturas o clics después de 30 días) no se registran | Mandrill conserva la información 30 días y no hay webhooks | ADR-005, ADR-014 |
| RA3 | Una cuenta de AD dada de baja conserva acceso hasta 15 minutos | Revisión periódica cada 15 minutos | ADR-006 |
| RA4 | Si el usuario ya falló en otro sistema, AD puede bloquearlo igual | El corte a los 2 intentos solo cubre los fallos hechos en EnvioTec | ADR-006 |

## 6. Riesgos técnicos abiertos

| ID | Riesgo | Resolución prevista | Estado |
| --- | --- | --- | --- |
| R1 | Polling a Mandrill: retención (30 días según el negocio), límites de `messages/info` y `messages/search`, falta de ID propio por evento | Spike de la fase 0.5; clave de idempotencia derivada (mensaje, tipo, timestamp, URL) | Abierto |
| R2 | Ancho de banda del adjunto | Envío por lotes con `merge_vars` por destinatario; confirmar en el spike que hay un `_id` por destinatario | Abierto |
| R3 | Envío duplicado por timeout tras aceptación | Estado `ambiguous` en `send_batches` y conciliación por metadata antes de reintentar | Abierto |
| R4 | Baja con un clic (RFC 8058) alojada por Mandrill | Verificar en el spike | Abierto |
| R5 | Fidelidad de la conversión de Word a HTML de correo | Acordar con el negocio el formato soportado; la vista previa muestra el resultado real | Abierto |
| R6 | Escape de variables en el lenguaje de merge de Mandrill | Verificar en el spike (ADR-013) | Abierto |
| R7 | Librerías XLSX con problemas de seguridad | Solo CSV en la v1 | Resuelto |
| R8 | Inspección de PDFs esquivable con object streams o nombres escapados | Normalizar con qpdf antes de inspeccionar; si qpdf falla, se rechaza | Resuelto (ADR-004) |
| R9 | Bloqueo de cuentas de AD desde EnvioTec | Corte a los 2 intentos, 15 minutos | Resuelto |
| R10 | Enrolamiento de MFA de cuentas de AD creadas por JIT (T7) | Código de enrolamiento de un solo uso emitido por un administrador y entregado por otro canal | Resuelto (ADR-006) |
| R11 | Allowlist de egreso por dominio | Proxy de egreso en compose | Resuelto (ADR-009) |
| R12 | Particiones mensuales con retención perpetua | El worker crea cada día 12 meses de particiones por delante y registra un error si quedan menos de 3 | Resuelto (Fase 4) |
| R13 | Entregabilidad: SPF, DKIM y DMARC del subdominio | Coordinar con quien administra el DNS y la cuenta de Mailchimp | Abierto (fuera del código) |
| R14 | Herramientas de `npm run check` (Trivy, gitleaks) | Se ejecutan como contenedores; requiere Docker donde corra Jenkins | Abierto (Fase 1) |
| R15 | Compatibilidad del proveedor LDAPS con el AD real (TLS con la CA interna, atributos, grupos anidados): Samba AD no se puede provisionar en el host de desarrollo | Directorio simulado en los tests (ADR-019); validación con el AD de la organización cuando estén sus datos | Abierto (Fase 3) |
| R16 | Recuperación por correo sin API key de sistema de Mandrill: el correo queda deshabilitado y se registra una advertencia | Configurar `MANDRILL_SYSTEM_API_KEY` y `MAIL_FROM` del subdominio verificado; probar en el spike 0.5 | Abierto (Fase 3) |
| R17 | Red hacia el controlador de dominio en producción: las redes del backend son internas | Red dedicada con firewall solo hacia el controlador de dominio (puerto 636), definida en el runbook | Abierto (Fase 9) |

## 7. Revisión de seguridad por fase

### Fase 1 — Base del proyecto (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| A6, deny by default | Toda ruta declara `public` o `permission`; si no, la app no arranca. Las rutas no públicas responden 401 hasta que exista autenticación | `tests/security/route-inventory.test.js` |
| T11 (mass assignment) | Los schemas de entrada deben declarar `additionalProperties: false` o la app no arranca; ajv rechaza (no descarta) propiedades desconocidas | `route-inventory.test.js`, `error-exposure.test.js` |
| Exposición de datos | Schema de respuesta obligatorio; los campos no declarados no se serializan | `error-exposure.test.js` |
| T29 (errores detallados) | Manejador central: 500 genérico con `requestId`; el detalle queda solo en el log | `error-exposure.test.js`, `errors.test.js` |
| T26 (secretos en logs) | Redacción en Pino de contraseñas, tokens, secretos, cookies y headers sensibles | `tests/unit/logger.test.js` |
| T26 (secretos en código y Git) | Docker secrets con `<VAR>_FILE`; `secrets/` ignorado; gitleaks sobre el historial | `npm run check` (paso 7) |
| A10 (configuración) | Validación al arrancar; secretos débiles o de ejemplo rechazados; mensajes sin valores | `tests/unit/config.test.js` |
| A8 (proxy confiable) | `trustProxy` limitado a la IP de nginx; nginx sobrescribe `X-Forwarded-For` | `trust-proxy.test.js` |
| A8 (headers) | CSP sin `unsafe-inline`/`unsafe-eval` con Trusted Types, HSTS, nosniff, COOP, CORP, Referrer-Policy, Permissions-Policy, en todas las respuestas; `Cache-Control: no-store` en la API | `edge.test.js`, `error-exposure.test.js` |
| T5/V12 (transporte) | TLS 1.2+ en nginx; HTTP redirige a HTTPS; TLS 1.1 rechazado | `edge.test.js` |
| A8 (DoS) | Límite de body 1 MB, timeouts de request y de nginx, `statement_timeout` en el pool y en el rol `app_runtime` | `error-exposure.test.js` (413), `integration/health.test.js` |
| A4 (mínimo privilegio en BD) | Roles `app_owner` y `app_runtime` sin superusuario; la app usa `app_runtime` | `integration/health.test.js` |
| ADR-003 (Redis) | ACL por servicio; `default` deshabilitado; comandos peligrosos denegados | `integration/health.test.js` |
| T40 (egreso) | Redes internas sin ruta a internet; Squid solo permite CONNECT 443 a la allowlist | `tests/security/egress.test.js` |
| A9 (frontend) | ESLint prohíbe `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`, `eval` y `localStorage`/`sessionStorage` | `npm run lint` |
| A11 (contenedores) | Usuarios no root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, límites de recursos, imágenes fijadas por digest, sin npm en la imagen de producción | Revisión de `docker-compose.yml` y Dockerfiles; Trivy |

**Pendiente para fases siguientes:** autenticación, sesiones, CSRF y rate limiting (Fase 3); `requirePermission`, migraciones y protección de auditoría (Fases 2 y 4); procesamiento de archivos (Fase 8.1).

**Hallazgos de la fase:**

- La imagen base de nginx traía `brotli-libs` (crítica) y `curl` (alta) vulnerables. Se actualiza `brotli-libs` y se elimina `curl` en `proxy/Dockerfile`; quitar ese paso cuando la imagen base incluya las correcciones.
- Nginx necesita una red no interna para publicar puertos y por eso tiene ruta de salida. En producción se bloquea con firewall del host (ADR-015, runbook de la Fase 9).
- Trivy se ejecuta con `--ignore-unfixed`: las vulnerabilidades sin corrección publicada no detienen el check. Se revisan en la Fase 9.
- Los secretos de desarrollo son legibles por otros usuarios dentro de los contenedores (los secretos de Compose fuera de Swarm conservan los permisos del host); el directorio `secrets/` tiene permisos 700 en el host. En producción se aplica lo mismo; se documenta en el runbook.

### Fase 2 — Base de datos y RBAC (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| A6 (401/403) | `requirePermission` por ruta: sin sesión válida 401, sin permiso 403; permisos efectivos cargados en cada request | `integration/authorization-matrix.test.js` (la matriz falla si una ruta protegida no tiene caso) |
| A6 (catálogo) | Una ruta con un permiso que no existe en el catálogo impide arrancar; el seed falla si la base tiene permisos que el código no declara | `route-inventory.test.js`, `database/tests/seed-and-bootstrap.test.js` |
| T8 / A5 (sesión) | Token de 256 bits; en la base solo su SHA-256 (CHECK de 32 bytes); sesión inválida si está revocada, vencida por inactividad o por tiempo absoluto, o si el usuario está desactivado, borrado, bloqueado o vencido | `authorization-matrix.test.js`, `unit/authorization.test.js` |
| T15 / A7 | `app_runtime` solo `INSERT`/`SELECT` en `audit_logs`; triggers rechazan `UPDATE`, `DELETE` y `TRUNCATE` incluso para el dueño | `database/tests/runtime-privileges.test.js`, `constraints.test.js` |
| A4 (mínimo privilegio) | `app_runtime` sin DDL, sin escritura en `permissions`, y en `system_settings` solo puede cambiar el valor | `runtime-privileges.test.js` |
| T35 / ADR-007 | Triggers: un rol administrativo no se asigna a una cuenta de AD ni desde un grupo de AD; un rol usado desde AD no recibe permisos administrativos; el rol de sistema no se borra, no se renombra ni pierde permisos | `constraints.test.js` |
| Parte B (origen único) | CHECKs: una cuenta de AD sin contraseña y con `objectGUID`; una local con contraseña, área y vigencia (salvo exención); `auth_source` inmutable; usuario y email únicos sin distinguir mayúsculas | `constraints.test.js` |
| A4 (integridad) | FKs restrictivas (un rol asignado no se borra), índices en cada FK, rangos de parámetros validados por la base | `constraints.test.js`, `runtime-privileges.test.js` |
| ADR-008 | Helper de alcance por área: condición parametrizada; sin área ni `areas.view_all` se niega el acceso; nombres de columna validados | `unit/authorization.test.js` |
| A5 (contraseñas) | Argon2id nativo en formato PHC, comparación en tiempo constante, rehash por cambio de parámetros, entrada limitada; política de 12 a 128 caracteres con lista de comunes y sus variantes (ADR-016) | `unit/password.test.js` |
| A6 (bootstrap) | Sin credenciales por defecto; el superadmin se crea una sola vez y la cuenta de emergencia también; la contraseña nunca se pasa por argumento ni por variable de entorno | `seed-and-bootstrap.test.js` |
| A11.8 | Las migraciones aplican, revierten y vuelven a aplicar sobre una base vacía | `npm run check` (paso 5) |

**Pendiente para fases siguientes:**

- Auditoría de cada 403, del bootstrap y de los cambios de seed (Fase 4, con el servicio de auditoría y la cadena de hash).
- MFA obligatorio para roles administrativos, `campaigns.submit` y `campaigns.approve`; login, CSRF y rate limiting (Fase 3). En esta fase las sesiones solo se validan; ninguna ruta las crea.
- Creación de particiones futuras de `audit_logs` por el worker (R12). La migración crea 13 meses; no hay partición por defecto: si falta una partición, la escritura de auditoría falla y con ella la acción (falla segura).
- Reglas anti-escalamiento del service (no otorgar permisos que no se tienen, no modificar los propios roles, último superadmin): Fases 5 y 6.

**Hallazgos de la fase:**

- Los tests de base de datos y la matriz usan las credenciales de `app_owner` dentro del entorno de verificación (para crear fixtures y probar que los triggers resisten incluso al dueño). Esas credenciales solo existen en `.check-secrets/`, que se genera y se borra en cada ejecución.
- `app_owner` puede desactivar triggers (`ALTER TABLE … DISABLE TRIGGER`) por ser dueño de las tablas. Se acepta: solo lo usan las migraciones, y la cadena de hash de la Fase 4 detecta cualquier alteración posterior.
- Trivy encontró 6 vulnerabilidades altas (`brace-expansion`, `undici`) en el npm que trae la imagen base de Node, dentro de la imagen `tools`. Se eliminó npm de `tools` (como ya se hacía en `runtime`) y los scripts se ejecutan con `node`.
- `npm audit` informa avisos moderados sin corrección compatible: `minimatch` (dependencia de ESLint, solo desarrollo) y `glob` (dependencia de `node-pg-migrate`, que solo lista el directorio fijo de migraciones, sin entrada del usuario). No llegan al umbral alto de A11; se revisan en la Fase 9.

### Fase 3 — Autenticación (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| A5 (sesión) | Token nuevo en cada login y al completar o configurar el MFA, al cambiar la contraseña; el login revoca la sesión que traía la cookie (session fixation); cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`; logout revoca en el servidor; vencimiento por inactividad y absoluto, revocado y auditado | `integration/auth-login.test.js`, `authorization-matrix.test.js`, `unit/auth-core.test.js` |
| A8 (CSRF) | Origin obligatorio en todo método que modifica estado, también en rutas públicas; token CSRF (HMAC del hash de la sesión) en `X-CSRF-Token` | `route-inventory.test.js`, `auth-login.test.js`, `unit/auth-core.test.js` |
| A5 (enumeración) | Mismo código, mensaje y tiempo similar con usuario inexistente (hash ficticio), contraseña incorrecta, cuenta bloqueada, desactivada o vencida; recuperación con la misma respuesta 202 y correo enviado después de responder | `auth-login.test.js`, `auth-mfa-password.test.js` |
| A5 (fuerza bruta) | Rate limiting en Redis por IP y por cuenta (429 + `Retry-After`); un intento a la vez por cuenta; bloqueo progresivo de cuentas locales (5 fallos, 1, 2, 4… minutos hasta 60) | `auth-login.test.js`, `unit/auth-core.test.js` |
| ADR-006 (AD) | LDAPS con la CA interna, cuenta de servicio, bind con el DN del usuario, filtros escapados (RFC 4515), contraseña vacía rechazada; estado de AD revisado en el login y en la re-autenticación con revocación de sesiones; JIT por `objectGUID`; área por `department`; roles de negocio por grupo; corte a los 2 intentos durante 15 minutos sin que AD llegue a 3; colisiones rechazadas y auditadas; AD caído responde 503 y no cuenta como fallo | `unit/ad-provider.test.js`, `integration/auth-ad.test.js` |
| Parte B (origen único) | Una cuenta local nunca se autentica contra AD aunque exista el mismo usuario en AD; una cuenta de AD no entra con AD deshabilitado | `auth-ad.test.js`, `auth-login.test.js` |
| T7 / Parte B (MFA) | TOTP (RFC 6238, verificado con los vectores del RFC) con secreto cifrado AES-256-GCM ligado al usuario; códigos sin reutilización (último paso guardado); 10 códigos de recuperación de un solo uso con hash; 5 fallos revocan la sesión; obligatorio con permisos administrativos, `campaigns.submit` o `campaigns.approve`; sin MFA verificado la sesión no usa sus permisos (ADR-018) | `auth-mfa-password.test.js`, `unit/auth-core.test.js`, `authorization-matrix.test.js` |
| ADR-006 (enrolamiento AD) | Código de enrolamiento de un solo uso, emitido con `users.reset_mfa` y re-autenticación, guardado como hash, con vigencia del parámetro de sistema y 5 intentos; nadie reinicia su propio MFA; el reinicio revoca las sesiones del usuario | `auth-mfa-password.test.js`, `unit/auth-core.test.js` |
| A5 (re-autenticación) | Contraseña o MFA de los últimos 5 minutos antes de reiniciar el MFA de otro y de configurar el MFA fuera del primer login | `auth-mfa-password.test.js`, `unit/auth-core.test.js` |
| A5 (contraseñas) | Cambio con la contraseña actual, política del baseline y revocación de las demás sesiones; contraseña inicial obliga a cambiarla; recuperación por correo con token de 256 bits, hash en base, un solo uso, 30 minutos (CHECK en la base), enlace en el fragmento de la URL, sin seguimiento de clics de Mandrill, revocación de todas las sesiones | `auth-mfa-password.test.js`, `unit/mailer.test.js` |
| A7 / T15 | Cadena de hash calculada en la base (`append_audit_log`, advisory lock, `audit_log_canonical`); cada acción y su evento en la misma transacción; todo 403 auditado; metadata sin campos sensibles | `database/tests/runtime-privileges.test.js`, `auth-mfa-password.test.js`, `authorization-matrix.test.js` |
| A6 (IDOR) | Las sesiones propias se listan y cierran solo con `user_id` en el WHERE: la sesión de otro usuario responde 404 | `auth-login.test.js` |

**Pendiente para fases siguientes:**

- Script de verificación de la cadena de auditoría, consulta, exportación y alerta por uso de la cuenta de emergencia (Fase 4).
- Revisión de AD cada 15 minutos por el worker, desbloqueo manual, alta de usuarios locales con contraseña inicial (Fase 5).
- Validación contra el AD real (R15), API key de sistema de Mandrill (R16) y red hacia el controlador de dominio (R17).
- Pantallas de login, MFA (QR a partir de `otpauthUri`) y recuperación (Fase 7).

**Hallazgos de la fase:**

- El plan aprobado preveía un Samba AD DC para los tests; no se puede provisionar en este host (ADR-019). Se reemplazó por un directorio simulado y queda R15.
- La columna `sessions.must_change_password_only` prevista en el plan no hizo falta: la etapa se calcula desde `users.must_change_password` (ADR-018).
- Los usuarios de los tests no se pueden borrar al terminar porque la auditoría los referencia con `ON DELETE RESTRICT`; los fixtures se marcan como borrados. Es el comportamiento esperado de la auditoría append-only.
- Durante las pruebas, un fixture con un token de recuperación de más de 30 minutos fue rechazado por el CHECK de la base: el control funciona también fuera de la aplicación.

### Fase 4 — Auditoría (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| T15 / A7 (detección) | `audit-verify.js` recorre la cadena en orden, recalcula cada hash y comprueba cada enlace: detecta registros alterados, eliminados o insertados fuera de `append_audit_log`; admite `--from`; corre como paso 8 de `npm run check` sobre todo lo que auditaron los tests | `database/tests/audit-verify.test.js`, `npm run check` |
| A7 (consulta) | `GET /api/v1/audit-logs` con `audit.view`: filtros validados y parametrizados, orden fijo, página máxima de 100, desplazamiento máximo de 10.000; sin hashes ni IDs de sesión en la respuesta | `integration/audit-logs.test.js`, `unit/audit-logs.test.js`, `authorization-matrix.test.js` |
| A7 (exportación) | `audit.export` + re-autenticación de los últimos 5 minutos; rango obligatorio de hasta 92 días; máximo 100.000 filas; CSV en streaming con BOM; la exportación queda auditada con filtros y cantidad de filas | `audit-logs.test.js`, `unit/audit-logs.test.js` |
| Contactos / auditoría (CSV injection) | Toda celda entrecomillada; las que empiezan con `=`, `+`, `-`, `@`, tabulación o retorno se prefijan con apóstrofo (`core/http/csv.js`, reutilizable por las exportaciones de negocio) | `unit/audit-logs.test.js`, `audit-logs.test.js` |
| Parte B (cuenta de emergencia) | Cada login registra `auth.emergency_login` destacado en la misma transacción y envía una alerta a `notifications.admin_emails` después de responder; si la lista está vacía queda una advertencia en el log | `audit-logs.test.js` |
| R12 | El worker crea cada día las particiones de los próximos 12 meses, serializado con advisory lock entre réplicas | `audit-logs.test.js` |
| A7 (seeds) | El seed de sistema registra `system.seed_sync` cuando cambia permisos, roles o parámetros; el bootstrap registra `user.bootstrap` | `database/tests/seed-and-bootstrap.test.js` |

**Pendiente para fases siguientes:**

- Retención: la aplicación nunca purga la auditoría (A7). El archivo en frío y el respaldo se definen en el runbook (Fase 9).
- La alerta de emergencia depende del correo del sistema (R16). Mientras no haya API key, el evento destacado queda en la auditoría y la advertencia en el log.
- Pantalla de auditoría (Fase 7).

**Hallazgos de la fase:**

- `audit.export` no es un permiso administrativo, así que un perfil de auditoría podía exportar sin MFA. Se decidió exigir re-autenticación para la exportación de auditoría (aprobado el 2026-10-31).
- `seq` tiene huecos cuando una transacción auditada se revierte. La verificación se basa en el enlace de los hashes, no en la continuidad de `seq`, y el informe distingue `altered` de `broken_link`.

### Fase 5 — Usuarios (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| A6 (anti-escalamiento) | Regla 1: no se asigna ni se quita un rol con permisos que el actor no tiene (403 `PRIVILEGE_ESCALATION`, auditado aunque la transacción se revierta); regla 2: nadie modifica sus propios roles; regla 3: no se desactiva ni se quita el rol al último superadmin activo (la cuenta de emergencia no cuenta; advisory lock contra carreras); regla 4: ningún rol administrativo a cuentas de AD (servicio y trigger); los roles de grupos de AD no se editan a mano; regla 6: todo cambio revoca las sesiones del usuario y se audita | `unit/users-rules.test.js` (todas las ramas), `integration/users.test.js` |
| A6 / ADR-008 (IDOR) | Todo usuario objetivo se carga con el alcance del actor: sin `areas.view_all`, otra área responde 404 en lectura y en cada acción; el alta solo en áreas activas del propio alcance | `users.test.js`, `authorization-matrix.test.js` |
| A8 (mass assignment) | Bodies con `additionalProperties: false` y listas cerradas de campos; `status`, `roles`, `passwordHash` y desconocidos responden 422 | `users.test.js` |
| A8 (inyección en listados) | Orden por allowlist (`SORT_COLUMNS`), búsqueda con `LIKE` escapado, filtros parametrizados, página máxima 100 y desplazamiento máximo 10.000 | `users.test.js` |
| A5 (re-autenticación) | Desactivar, reactivar, asignar roles, resetear contraseña, renovar y cambiar el email exigen re-autenticación de los últimos 5 minutos | `users.test.js`, `authorization-matrix.test.js` |
| A5 (contraseña inicial) | 120 bits aleatorios generados por el servidor, mostrados una sola vez; obligan a cambiarla en el primer login; el reset por administrador revoca las sesiones | `users.test.js` |
| Parte B (vigencia) | Alta con vigencia por defecto y nunca mayor al máximo; renovación con motivo, hasta 90 días, sin superar el máximo desde hoy, nunca la propia, reactiva solo cuentas desactivadas por vencimiento o inactividad; trabajo horario que desactiva vencidas e inactivas (45 días desde el último acceso, la creación o la última renovación), revoca sesiones, audita y avisa una vez antes del vencimiento a la cuenta y a los administradores | `unit/users-rules.test.js`, `users.test.js`, `user-jobs.test.js` |
| Parte B (AD) | Revisión cada 15 minutos: cuenta deshabilitada, vencida, inexistente o fuera del grupo pierde sus sesiones (auditado solo cuando revoca); área y roles de grupo siguen a AD y un cambio de roles revoca las sesiones; con AD caído la ronda se aborta sin revocar | `user-jobs.test.js` |
| ADR-020 | Cada trabajo corre en una sola réplica a la vez (advisory lock de sesión) | `user-jobs.test.js` |
| A10 (errores de base) | Violaciones de `UNIQUE` y de FK se traducen a 409 sin exponer SQL ni restricciones | `users.test.js` |

**Pendiente para fases siguientes:**

- Gestión de roles, de permisos por rol y de equivalencias de grupos de AD (Fase 6).
- Parámetros del sistema editables por `settings.manage` (Fase 6, junto con la administración).
- Pantallas de usuarios y áreas (Fase 7). La contraseña temporal se muestra una sola vez y la UI debe advertirlo.
- Los avisos por correo dependen de la API key de sistema (R16).

**Hallazgos de la fase:**

- En el plan escribí que la cuenta de emergencia quedaba exenta de vigencia pero no de inactividad. Al implementarlo se vio que eso la desactivaría a los 45 días sin uso, justo lo contrario de su propósito: existe para el día en que nadie más puede entrar. Las cuentas exentas de vigencia también quedan exentas de la desactivación por inactividad; el MFA sigue siendo obligatorio y cada uso alerta a los administradores (Fase 4).
- La revisión de AD no cambia el `status` de las cuentas: revoca sus sesiones y el login vuelve a consultar AD. Así, una cuenta rehabilitada en AD recupera el acceso sin intervención manual.
- La cobertura de `npm run check` pasó a medir también `src/modules/**` (services incluidos), como pide A11.

### Fase 6 — Roles y permisos (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| A6 regla 1 | Crear un rol o cambiar sus permisos solo con permisos que el actor tiene, también para quitarlos; 403 `PRIVILEGE_ESCALATION` auditado aunque la transacción se revierta | `unit/roles-rules.test.js`, `integration/roles-admin.test.js` |
| A6 (rol propio) | Nadie cambia los permisos de un rol que tiene (aprobado en el plan de la fase) | `roles-rules.test.js`, `roles-admin.test.js` |
| A6 reglas 4 y 5 | El rol de sistema no se renombra, no cambia permisos y no se borra (servicio y triggers); un rol asignado o mapeado desde AD no se borra | `roles-rules.test.js`, `roles-admin.test.js` |
| A6 regla 6 / A5 | Todo cambio de permisos de un rol revoca las sesiones de sus usuarios y se audita con lo agregado, lo quitado y el estado anterior | `roles-admin.test.js` |
| ADR-007 | Un rol usado por cuentas de AD o mapeado desde un grupo no recibe permisos administrativos (servicio y trigger); los grupos de AD solo se mapean a roles de negocio; DN validado y, con AD habilitado, el grupo debe existir | `roles-rules.test.js`, `roles-admin.test.js` |
| A6 (revisión de accesos) | Permisos efectivos por usuario con los roles que otorgan cada uno e indicador de MFA obligatorio, con alcance por área | `roles-admin.test.js`, `authorization-matrix.test.js` |
| Parte B (parámetros) | `settings.manage` + re-autenticación; rango validado en el backend y en la base; listas de emails y dominios validadas y normalizadas; la vigencia por defecto y la renovación no superan la máxima; auditoría con valor anterior y nuevo | `roles-rules.test.js`, `roles-admin.test.js` |
| Criterio de salida | Reglas contra escalamiento (`users.rules.js`, `roles.rules.js`) con 100 % de líneas, ramas y funciones | `npm run check` (cobertura) |

**Pendiente para fases siguientes:**

- Pantallas de roles, permisos efectivos, equivalencias de AD y parámetros (Fase 7).
- Validar las equivalencias contra el AD real (R15).

**Hallazgos de la fase:**

- `pg` no reconoce los arreglos de `citext` y los devuelve como texto; el schema de respuesta lo rechazó con un 500 en los tests. Los nombres de rol se convierten a `text` al agregarlos. Las demás consultas usan `json_agg` o columnas `text`.
- Revocar las sesiones de todos los usuarios de un rol al cambiar sus permisos obliga a todos ellos a iniciar sesión de nuevo; se aceptó en el plan por consistencia con A5.

### Fase 7 — Frontend del núcleo (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| A9 / XSS | Todo nodo se crea con `core/dom.js` (`textContent`, atributos por allowlist, sin `on*`, `style` ni `srcdoc`, URLs solo relativas, `https:`, `mailto:` y los `data:`/`blob:` que crea la app); ningún sink HTML; lint con `no-unsanitized` y propiedades prohibidas | `frontend/tests/core.test.js`, `npm run lint` |
| A8 / A9 (CSP y Trusted Types) | Sin scripts, estilos ni handlers inline; ES Modules con import literal; prueba en Chromium real que falla ante cualquier violación de CSP o de Trusted Types y ante errores en consola | `e2e/run.mjs` (paso 8 de `npm run check`) |
| A9 (frontend no es control) | `auth.hasPermission` y el router solo muestran u ocultan; cada acción la decide el backend | `frontend/tests/core.test.js` (router), matriz de autorización del backend |
| A8 (CSRF) | Cliente único: cookies same-origin y `X-CSRF-Token` en métodos que modifican, nunca en GET | `frontend/tests/core.test.js` |
| A9 (errores) | Manejo central: 401 al login, etapa pendiente a su pantalla, re-autenticación con diálogo y un reintento, 409/422 por campo, 429 con espera, 5xx genérico con `requestId`, nunca detalles técnicos | `frontend/tests/core.test.js` |
| A5 (tokens) | Ningún token en `localStorage`, `sessionStorage` ni en la URL: el token de recuperación se lee del fragmento y se borra del historial con `history.replaceState`; contraseñas temporales, códigos de enrolamiento y de recuperación se muestran una sola vez con aviso | revisión de código, `e2e/run.mjs` |
| Parte B (i18n) | Español e inglés con las mismas claves; cada clave usada en el código existe; idioma en cookie no sensible (ADR-021) | `frontend/tests/i18n.test.js` |
| ADR-006 (QR) | QR del TOTP como SVG `data:` en un `<img>`, sin marcado en el DOM ni scripts en el SVG | `integration/auth-mfa-password.test.js`, `e2e/run.mjs` |

**Pendiente para fases siguientes:**

- Pantallas de los módulos de negocio (Fase 8), con los mismos componentes.
- Revisión de accesibilidad con un lector de pantalla y prueba en los navegadores corporativos (Fase 9).

**Hallazgos de la fase:**

- El origen del entorno de verificación pasó a ser `https://nginx:8443` para que el navegador de la prueba cumpla el control de `Origin`; los tests del backend siguen usando su propio origen.

### Fase 8.1 — Remitentes y cuotas (2026-10-31)

**Controles implementados y verificados por tests:**

| Amenaza o requisito | Control | Verificación |
| --- | --- | --- |
| Parte B (remitentes) | El From solo del subdominio de envío (`sending.sender_domains`) y el Reply-To solo de dominios con buzones (`sending.reply_to_domains`); sin dominios configurados no se crean remitentes; únicos por área; nunca se borran; el email no cambia | `unit/quotas-senders-rules.test.js`, `integration/senders-quotas.test.js` |
| Inyección de cabeceras | El nombre visible no admite saltos de línea, comillas ni `<>` (schema y CHECK en la base) | `senders-quotas.test.js` |
| ADR-008 | El operador ve solo los remitentes activos de su área | `senders-quotas.test.js` |
| ADR-011 (cuotas) | `reserved + consumed <= assigned` y no negativos (CHECK); toda operación con `SELECT … FOR UPDATE`; dos reservas simultáneas no superan el saldo | `senders-quotas.test.js` |
| Parte B (abuso interno) | Ajuste con `quotas.manage`, motivo y re-autenticación; nadie ajusta su propio saldo; sin `areas.view_all` cada usuario ve solo el suyo | `senders-quotas.test.js`, `authorization-matrix.test.js` |
| A7 / ADR-011 | `quota_movements` append-only, con un trigger que rechaza `UPDATE`, `DELETE` y `TRUNCATE` incluso para el dueño; cada movimiento también en la auditoría, en la misma transacción | `senders-quotas.test.js` |
| Parte B (tope global) | `monthly_send_usage` por mes de America/La_Paz con bloqueo de fila; superar el tope responde `GLOBAL_CAP_REACHED` sin consumir nada | `senders-quotas.test.js`, `unit/quotas-senders-rules.test.js` |

**Pendiente para fases siguientes:**

- Reserva al aprobar, consumo por lote, liberación al cancelar o volver a borrador, y pausa de campañas al llegar al tope (8.4 y 8.5). Los bloques ya están listos y probados.
- Una cuenta local vencida no puede usar su saldo (ADR-011): se valida al aprobar y al enviar (8.4).
- Configurar los dominios reales de envío y de Reply-To (pendiente del negocio).

