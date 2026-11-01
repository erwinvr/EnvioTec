# EnvioTec — Arquitectura

Estado: Fase 0 aprobada (2026-10-31).

Este documento describe la arquitectura, el modelo de datos, el catálogo de permisos, las dependencias y el plan de fases de EnvioTec. Parte de la Parte A (`docs/baseline.md`) y de la Parte B (`docs/project-spec.md`); los ajustes respecto del baseline están justificados en los ADR de `docs/decisions/`.

## 1. Componentes

| Servicio | Función | Redes |
| --- | --- | --- |
| `nginx` | Proxy de borde: TLS (CA interna), archivos estáticos en `/`, `/api/*` al backend, headers de seguridad (ADR-001) | `edge` |
| `backend` | Fastify, N réplicas sin estado | `edge`, `data`, `egress` |
| `worker` | BullMQ: envíos, sincronización con Mandrill, vigencia de cuentas, revisión de AD, mantenimiento de particiones | `data`, `files`, `egress` |
| `file-processor` | Validación y conversión de .docx, CSV y PDF (ADR-004) | `files` |
| `clamav` | Antivirus (`clamd`) | `files` |
| `freshclam` | Actualización de firmas de ClamAV | `egress` |
| `egress-proxy` | Única salida a internet, con allowlist de dominios (ADR-009) | `egress` + salida |
| `postgres` | PostgreSQL 18 (ADR-010) | `data` |
| `redis` | Colas y contadores; `noeviction` + AOF; usuarios ACL por servicio (ADR-003) | `data`, `files` |

- La red `files` es `internal: true`: el procesador solo ve Redis y ClamAV.
- El backend y el worker llegan al controlador de dominio por LDAPS a través de la red del host, restringido por firewall a la IP del controlador.
- Los archivos pasan entre el worker y el procesador por un volumen compartido privado.
- PostgreSQL y Redis no publican puertos en producción.

```text
 Navegador
    │ HTTPS (CA interna)
    ▼
 nginx ── /        → estáticos
   │      /api/*   → backend
   ▼
 backend (N) ──────────┬───────────── LDAPS ──▶ Controlador de dominio
   │                   │
   ▼                   ▼
 postgres           redis ◀──── worker ──── LDAPS ──▶ Controlador de dominio
                      ▲          │   │
                      │          │   └──▶ egress-proxy ──▶ mandrillapp.com
             file-processor ◀────┘                     └─▶ firmas ClamAV (freshclam)
                      │
                    clamav
```

## 2. Flujos principales

**Campaña:**

1. El operador crea la campaña (plantilla + lista + PDF + remitente + fecha).
2. La envía a aprobación (`campaigns.submit`, MFA).
3. Un aprobador distinto la aprueba (`campaigns.approve`, MFA, re-autenticación). En la misma transacción: se genera la foto de destinatarios (`campaign_recipients`), se excluye la supresión y se reserva la cuota del creador con bloqueo de fila.
4. A la hora programada (America/La_Paz, almacenada en UTC), el worker envía por lotes. Antes de cada lote vuelve a aplicar la supresión y controla el tope global mensual. Cada destinatario aceptado pasa de reservado a consumido.
5. Editar una campaña aprobada o programada sin envíos iniciados la devuelve a borrador y libera la reserva. Una campaña enviando o en pausa solo se puede cancelar; al cancelar se libera la reserva no consumida.

**Archivo subido:**

1. El backend recibe el archivo con límite de bytes y lo guarda en cuarentena con nombre UUID.
2. Encola un trabajo; el worker lo pasa al procesador.
3. El procesador valida el tipo por contenido, escanea con ClamAV y, según el tipo, convierte el .docx a HTML sanitizado, normaliza e inspecciona el PDF con qpdf o valida el CSV por fila.
4. El resultado vuelve por la cola; el worker lo persiste. Un archivo rechazado queda marcado con el motivo y no se usa.

**Sincronización:** el worker consulta Mandrill periódicamente (muy por debajo de los 30 días de retención), guarda estados y eventos con clave de idempotencia y actualiza la supresión con bajas, rebotes duros y quejas.

**AD:** en el login se busca al usuario con la cuenta de servicio (filtro escapado) y se hace bind con su DN. Si es su primer login y pertenece al grupo habilitado, se crea la cuenta (JIT). Cada 15 minutos el worker revisa las cuentas de AD activas: deshabilitadas, fuera del grupo, cambio de `department` o de grupos → se actualiza, se audita y se revocan sesiones.

## 3. Modelo de datos

Convenciones (A4): PK UUIDv7 con `uuidv7()` de PostgreSQL 18; `timestamptz` en UTC; `created_at` y `updated_at` en tablas de negocio; FK con índice; integridad con `NOT NULL`, `UNIQUE` y `CHECK` en la BD. Todas las tablas de negocio tienen `area_id NOT NULL`.

### 3.1 Núcleo

| Tabla | Campos principales y restricciones |
| --- | --- |
| `users` | Campos de A4 más `auth_source` (`local`, `ad`), `ad_object_guid` (único), `area_id` (nullable), `expires_at`, `exempt_from_expiry`, `is_emergency`, `last_login_at`, `must_change_password`. CHECK: `ad` ⇒ `password_hash IS NULL` y `ad_object_guid NOT NULL`; `local` ⇒ al revés. `local` ⇒ `area_id NOT NULL`. `username` y `email` únicos entre ambos orígenes (`citext`) |
| `roles` | `name` único, `description`, `is_system`, `is_administrative` (calculado al cambiar permisos) |
| `permissions` | `code` único, `description`, `is_administrative`. Solo por seed |
| `user_roles` | PK compuesta, `source` (`manual`, `ad_group`), `assigned_by`, `assigned_at`. Trigger: un rol administrativo no se asigna a un usuario `ad`; un rol con `source = ad_group` no puede ser administrativo |
| `role_permissions` | PK compuesta, `granted_by`, `granted_at` |
| `sessions` | Campos de A5 |
| `password_reset_tokens` | Campos de A4 |
| `mfa_recovery_codes` | `user_id`, `code_hash`, `used_at` |
| `audit_logs` | Campos de A7 más `actor_type` (`user`, `system`). Particionada por mes |

### 3.2 Administración

| Tabla | Contenido |
| --- | --- |
| `areas` | `name` único, `ad_department` (único, comparación sin mayúsculas), `is_active` |
| `ad_group_role_mappings` | DN del grupo → rol de negocio; marca del grupo habilitado |
| `system_settings` | `key`, `value`, `min`, `max`, `updated_by`, `updated_at` |
| `local_account_renewals` | `user_id`, `previous_expires_at`, `new_expires_at`, `reason`, `renewed_by` |
| `sender_identities` | `area_id`, `email`, `display_name`, `is_active` |
| `mfa_enrollment_codes` | `user_id`, `code_hash`, `issued_by`, `expires_at`, `used_at`, `failed_attempts` (ADR-006) |

Parámetros iniciales de `system_settings` (además de los de vigencia de cuentas locales):

| Clave | Valor por defecto |
| --- | --- |
| `sending.monthly_global_cap` | 100000 |
| `mfa.enrollment_code_validity_hours` | 24 (rango 1–72) |
| `test_send.daily_max_per_user` | 5 |
| `test_send.allowed_domains` | (lista definida en la instalación) |
| `notifications.admin_emails` | (lista definida en la instalación) |

Los parámetros de seguridad de la autenticación (intentos y bloqueo de AD, timeouts) van en variables de entorno, no en `system_settings`.

### 3.3 Negocio

| Tabla | Contenido |
| --- | --- |
| `stored_files` | `kind` (`docx`, `csv`, `pdf`, `image`), `sha256`, `size_bytes`, `storage_key` (UUID), `scan_status`, `validation_status`, `rejection_reason` |
| `templates` | `area_id`, nombre, versión vigente |
| `template_versions` | Inmutable: `docx_file_id`, `html`, `subject`, `variables` (array), imágenes inline, `status` |
| `contact_lists` | `area_id`, nombre, definición de atributos |
| `contacts` | `area_id`, `email` (`citext`, único por área), `first_name`, `last_name`, `attributes` JSONB, `anonymized_at`, `pseudonym_id` |
| `contact_list_members` | PK compuesta |
| `contact_imports` / `contact_import_errors` | Estado del trabajo; una fila por fila rechazada |
| `suppressions` | Global: `email_hash` único, `email` (nullable tras anonimizar), `reason` (`unsub`, `hard_bounce`, `complaint`, `manual`), `source` |
| `campaigns` | `area_id`, `status` (CHECK de estados), `template_version_id`, `list_id`, `pdf_file_id`, `sender_identity_id`, `scheduled_at`, `created_by`, `submitted_by`, `approved_by`. CHECK `approved_by <> submitted_by` |
| `campaign_state_changes` | Append-only: estado anterior, nuevo, actor, motivo |
| `campaign_recipients` | Particionada por mes: foto del destinatario, merge vars, `provider_message_id`, `status`, `attempts`, `batch_id` |
| `send_batches` | `status` (`pending`, `in_flight`, `accepted`, `ambiguous`, `failed`) |
| `message_events` | Particionada por mes: `idempotency_key` único, tipo, timestamp, datos |
| `test_sends` | Usuario, fecha, destinatario (límite diario) |
| `quotas` | `user_id` único, `assigned`, `reserved`, `consumed`. CHECK `reserved + consumed <= assigned` y no negativos |
| `quota_movements` | Append-only: `reserve`, `consume`, `release`, `adjust`; actor, campaña, motivo |
| `monthly_send_usage` | `month` (America/La_Paz), `consumed`; bloqueo de fila contra el tope global |
| `sync_state` | Cursores de sincronización |

## 4. Permisos y roles

### 4.1 Catálogo

| Grupo | Permisos |
| --- | --- |
| Núcleo | `users.view`, `users.update`, `users.disable`, `users.reset_password`, `users.reset_mfa`, `users.unlock`, `roles.view`, `roles.create`, `roles.update`, `roles.delete`, `roles.assign`, `permissions.view`, `sessions.view_any`, `sessions.revoke_any`, `audit.view`, `audit.export` |
| Administración | `users.create_local`, `users.renew_local`, `settings.manage`, `areas.view_all`, `areas.manage`, `directory.manage`, `senders.manage` |
| Plantillas | `templates.view`, `templates.create`, `templates.update`, `templates.delete` |
| Contactos | `contacts.view`, `contacts.create`, `contacts.update`, `contacts.import`, `contacts.export`, `contacts.delete`, `suppressions.view`, `suppressions.manage` |
| Campañas | `campaigns.view`, `campaigns.create`, `campaigns.update`, `campaigns.delete`, `campaigns.submit`, `campaigns.approve`, `campaigns.cancel`, `campaigns.pause`, `campaigns.send_test` |
| Cuotas | `quotas.view`, `quotas.manage` |
| Reportes | `reports.view`, `reports.export` |

`users.create` del baseline no se usa. `suppressions.manage` solo agrega entradas; quitar una entrada de supresión exige `superadmin`.

**Permisos administrativos** (`is_administrative`): `users.*` salvo `users.view`; `roles.*` salvo `roles.view`; `settings.manage`, `areas.manage`, `directory.manage`, `senders.manage`, `quotas.manage`, `sessions.revoke_any`, `suppressions.manage`. Un rol con alguno de ellos es administrativo: exige MFA y solo puede asignarse a cuentas locales.

**MFA obligatorio:** cualquier permiso administrativo, `campaigns.submit` o `campaigns.approve`.

### 4.2 Roles iniciales

| Rol | Permisos | Origen permitido | MFA |
| --- | --- | --- | --- |
| `superadmin` (sistema) | Todos | Solo local | Sí |
| `administrador` | Núcleo, administración, `quotas.*`, `suppressions.*`, lectura de negocio | Solo local | Sí |
| `operador` | `templates.*`; `contacts.*` salvo `contacts.export`; `suppressions.view`; `campaigns.view/create/update/delete/submit/cancel/pause/send_test`; `quotas.view` (propia); `reports.view` | Local o AD | Sí |
| `aprobador` | `campaigns.view/approve/cancel/pause`, `templates.view`, `contacts.view`, `reports.view` | Local o AD | Sí |
| `auditoria` | `audit.view/export`, `users.view`, `roles.view`, `permissions.view`, `sessions.view_any`, `areas.view_all`, `reports.view`, `campaigns.view`, `quotas.view` | Local o AD | No |
| `reportes` | `reports.view/export`, `campaigns.view`, `areas.view_all` | Local o AD | No |

## 5. Dependencias

Versiones exactas y `package-lock.json` versionado. La licencia y el estado de mantenimiento se revisan en npm al agregar cada una (Fase 1 en adelante).

| Dependencia | Para qué | Por qué no nativo | Licencia |
| --- | --- | --- | --- |
| `fastify` | Framework (A2) | — | MIT |
| `@fastify/cookie` | Cookies con prefijo `__Host-` | Parseo manual propenso a errores | MIT |
| `@fastify/multipart` | Subida de archivos con límites en streaming | Multipart manual es frágil | MIT |
| `@fastify/rate-limit` | Rate limiting general con Redis | El límite por cuenta del login es lógica propia | MIT |
| `pg` | Driver de PostgreSQL (A2) | — | MIT |
| `node-pg-migrate` | Migraciones (A2) | — | MIT |
| `ioredis` | Cliente Redis (lo usa BullMQ) | — | MIT |
| `bullmq` | Colas, reintentos, trabajos programados | Reimplementar una cola fiable no tiene sentido | MIT |
| `ajv-formats` | Formatos `email`, `uuid`, `date-time` | Fastify trae ajv sin los formatos | MIT |
| `ldapts` | Cliente LDAPS | No hay LDAP nativo | MIT |
| `mammoth` | .docx a HTML | No existe en Node | BSD-2-Clause |
| `yauzl` | Inspección del ZIP antes de descomprimir | `zlib` no lee el directorio central | MIT |
| `sanitize-html` | Sanitización de HTML en el servidor | DOMPurify requiere jsdom | MIT |
| `csv-parse` | Importación CSV en streaming | Comillas y saltos de línea en campos | MIT |
| `uqr` | QR (SVG) para enrolar el TOTP, en el backend | No compensa codificar QR a mano; reemplaza a `qrcode`, que arrastra `yargs` (ADR-021) | MIT |
| `argon2` | Argon2id, solo si `crypto.argon2` de Node no es estable en la LTS elegida | Se verifica en la Fase 1 | MIT |

Implementado con funcionalidad nativa: TOTP (RFC 6238 con `crypto`, probado con los vectores del RFC), cifrado AES-256-GCM, UUIDv7 (PostgreSQL 18), cliente de Mandrill (`fetch`), i18n (diccionarios JSON), cobertura (`node --test`).

Solo de desarrollo: `eslint`, `eslint-plugin-security` (Apache-2.0), `eslint-plugin-no-unsanitized` (MPL-2.0), `pino-pretty`, `playwright-core` (Apache-2.0, verificación en navegador, ADR-021).

Herramientas fuera de npm (contenedores): qpdf (Apache-2.0), ClamAV (GPL-2.0, servicio separado), nginx, gitleaks (MIT), Trivy (Apache-2.0), proxy de egreso (se elige en la Fase 1 y se justifica en ADR-009).

## 6. Plan de fases

| Fase | Contenido |
| --- | --- |
| 0. Análisis | Este documento, `security.md`, ADR iniciales |
| 0.5 Spike Mandrill | Prueba con una API key de pruebas para resolver R1–R4 y R6. Sin código de producción; el resultado actualiza ADR-005 y ADR-013 |
| 1. Base | Estructura, compose (nginx, backend, worker vacío, postgres, redis, egress-proxy), redes, config validada, logger, errores, headers, health checks, `npm run check` |
| 2. BD y RBAC | Migraciones del núcleo con `auth_source`, `areas`, `system_settings`; catálogo de permisos completo; roles; triggers de roles administrativos; bootstrap de superadmin y cuenta de emergencia; inventario de rutas; filtro por área en repositories |
| 3. Autenticación | Proveedor local y LDAPS, JIT, MFA y enrolamiento, re-autenticación, recuperación por correo (API key de sistema), verificación de `expires_at`, bloqueo 2 intentos / 15 minutos para AD |
| 4. Auditoría | Script de verificación de la cadena, consulta y exportación, alerta de cuenta de emergencia (la escritura encadenada y la auditoría de 403 se adelantaron a la Fase 3, ADR-018) |
| 5. Usuarios | Alta y edición de locales con vigencia, renovación, revisión de cuentas locales, trabajos de vigencia diaria y revisión de AD cada 15 minutos, áreas |
| 6. Roles y permisos | A6 más equivalencias de grupos de AD a roles de negocio |
| 7. Frontend del núcleo | C1 con i18n español e inglés |
| 8.1 Pipeline de archivos | Procesador aislado, ClamAV, freshclam, qpdf, validación de .docx, CSV y PDF |
| 8.2 Plantillas | Versionado, variables, sanitización, vista previa aislada |
| 8.3 Contactos y supresión | CSV, deduplicación, listas, supresión global, exportación segura, anonimización |
| 8.4 Remitentes y cuotas | Remitentes por área, saldos, tope global, movimientos |
| 8.5 Campañas | Máquina de estados, aprobación, foto de destinatarios, reserva, regla de edición, envíos de prueba |
| 8.6 Worker de envío | Lotes, idempotencia, conciliación, pausa y cancelación, tope global, America/La_Paz |
| 8.7 Sincronización y reportes | Polling, eventos, supresión, reportes, exportación |
| 9. Hardening | ASVS L2, escaneos, configuración de producción, runbook |
