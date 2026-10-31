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
| R12 | Particiones mensuales con retención perpetua | El worker crea particiones con meses de anticipación; alerta si falta alguna | Abierto (Fase 2/8) |
| R13 | Entregabilidad: SPF, DKIM y DMARC del subdominio | Coordinar con quien administra el DNS y la cuenta de Mailchimp | Abierto (fuera del código) |
| R14 | Herramientas de `npm run check` (Trivy, gitleaks) | Se ejecutan como contenedores; requiere Docker donde corra Jenkins | Abierto (Fase 1) |
