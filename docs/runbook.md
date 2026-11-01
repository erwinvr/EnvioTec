# EnvioTec — Runbook de operación

Procedimientos para desplegar, respaldar, restaurar y operar EnvioTec en producción. Todos los comandos se ejecutan desde la raíz del repositorio, en el servidor, con el stack de producción: `docker-compose.yml`, **sin** el override de desarrollo.

```bash
alias dc='docker compose -f docker-compose.yml'
```

## 1. Requisitos del servidor

| Requisito | Detalle |
| --- | --- |
| Docker | Engine y plugin Compose v2, con un usuario operador del grupo `docker` (no root) |
| Red | Accesible solo desde la red interna. El puerto 443 publicado por `nginx` es el único expuesto |
| Certificado TLS | Emitido por la CA interna para el nombre del servidor (`tls_cert`, `tls_key`) |
| Egreso | El proxy de egreso (`egress-proxy`) sale solo hacia `mandrillapp.com` y los mirrors de ClamAV. El firewall del host debe bloquear cualquier otra salida de los contenedores |
| Controlador de dominio | Puerto 636 (LDAPS) alcanzable desde la red `directory` (sección 8) |
| Disco | Volúmenes `pgdata`, `filestore` (PDF e imágenes, retención perpetua) y `clamavdb`. Vigilar el crecimiento (sección 10) |
| Respaldos | Destino fuera del servidor, cifrado y con acceso restringido (sección 4) |

## 2. Primer despliegue

1. **Secretos.** Cree el directorio de secretos (`SECRETS_DIR`, por defecto `./secrets`) con permisos `700`, propiedad del operador. Ponga un archivo por secreto, sin salto de línea final, con los nombres de la sección `secrets:` de `docker-compose.yml`:

   ```bash
   umask 077; mkdir -p secrets
   for name in postgres_password db_owner_password db_runtime_password redis_backend_password redis_worker_password redis_files_password; do
     openssl rand -hex 32 | tr -d '\n' > "secrets/$name"
   done
   openssl rand -base64 48 | tr -d '\n' > secrets/csrf_secret
   openssl rand -base64 32 | tr -d '\n' > secrets/data_encryption_key
   ```

   - Las URL de conexión (`database_url`, `migration_database_url`, `redis_url_backend`, `redis_url_worker` y `redis_url_files`) siguen el formato de `scripts/generate-dev-secrets.sh` y usan las contraseñas anteriores.
   - `tls_cert` y `tls_key` son el certificado de la CA interna y su clave.
   - Las keys de Mandrill (de sistema y de campañas), la contraseña de bind de LDAP y la CA de AD se agregan como secretos adicionales (secciones 8 y 9).
   - **Nunca** entran al repositorio ni se pegan en tickets o chats.
   - Guarde una copia de `data_encryption_key` en el gestor de contraseñas de la organización: sin ella, los MFA ya configurados no se pueden recuperar.

2. **Construir y levantar:**

   ```bash
   dc build
   dc up -d --wait postgres redis
   dc run --rm tools node scripts/migrate.js up
   dc run --rm tools node scripts/seed.js system
   dc up -d --wait
   ```

3. **Cuentas iniciales:**

   ```bash
   dc run --rm -it tools node scripts/bootstrap-admin.js               # superadmin
   dc run --rm -it tools node scripts/bootstrap-admin.js --emergency   # cuenta de emergencia (Parte B)
   ```

   - Las dos cuentas configuran el MFA en su primer ingreso.
   - Las credenciales de la cuenta de emergencia se guardan en sobre cerrado o en una bóveda, con acceso de dos personas.

4. **Parámetros** (pantalla *Parámetros*, permiso `settings.manage`):
   - `notifications.admin_emails`;
   - dominios de envío y de Reply-To;
   - dominios permitidos para envíos de prueba;
   - tope global mensual.

5. **Verificación:**

   ```bash
   curl --cacert secrets/tls_cert -fsS https://<servidor>/health/ready
   dc run --rm tools node scripts/audit-verify.js
   ```

## 3. Actualización a una nueva versión

1. Antes de actualizar, en el entorno de verificación: `npm run check` en verde para el commit a desplegar.
2. Respaldo completo (sección 4).
3. Despliegue:

   ```bash
   git fetch && git checkout <tag>
   dc build
   dc run --rm tools node scripts/migrate.js up
   dc run --rm tools node scripts/seed.js system     # sincroniza permisos y parámetros nuevos
   dc up -d --wait
   dc run --rm tools node scripts/audit-verify.js
   ```

4. **Reversión:**
   - si la versión nueva no arranca: `dc run --rm tools node scripts/migrate.js down <n>`, con `n` igual a las migraciones nuevas de esa versión;
   - después, `git checkout <tag anterior> && dc build && dc up -d --wait`;
   - si una migración no puede revertirse sin perder datos, restaure el respaldo del paso 2.

## 4. Respaldo y restauración

**Qué se respalda:**
- la base `enviotec` (incluye la auditoría, que nunca se purga);
- el volumen `filestore`: PDF enviados e imágenes de plantillas, con retención perpetua (Parte B);
- el directorio de secretos, por separado y con otro custodio.

**Respaldo diario**, programado con cron o un temporizador de systemd:

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dc exec -T postgres pg_dump -U postgres -d enviotec -Fc > "backup/enviotec-$stamp.dump"
docker run --rm -v enviotec_filestore:/data:ro -v "$PWD/backup:/backup" alpine:3.22 \
  tar -czf "/backup/filestore-$stamp.tar.gz" -C /data .
sha256sum backup/*-"$stamp".* > "backup/SHA256SUMS-$stamp"
```

- Cifre los archivos antes de copiarlos fuera del servidor, por ejemplo con `age` o `gpg` usando la clave pública del custodio.
- Retención sugerida: 30 diarios, 12 mensuales y los anuales que defina la organización.
- El dump contiene datos personales de contactos: tiene el mismo nivel de protección que la base.

**Restauración**, que se prueba al menos cada trimestre en un servidor aparte:

```bash
dc down
docker volume rm enviotec_pgdata enviotec_filestore
dc up -d --wait postgres          # crea los roles con los secretos actuales (database/init)
dc exec -T postgres pg_restore -U postgres -d enviotec --no-owner --role=app_owner < backup/enviotec-<stamp>.dump
docker run --rm -v enviotec_filestore:/data -v "$PWD/backup:/backup:ro" alpine:3.22 \
  tar -xzf /backup/filestore-<stamp>.tar.gz -C /data
dc run --rm tools node scripts/migrate.js up
dc up -d --wait
dc run --rm tools node scripts/audit-verify.js   # la cadena debe verificarse íntegra
```

- `pg_restore` sobre una base recién inicializada restaura también los permisos de `app_runtime`, porque las migraciones los otorgan de forma explícita.
- Después, `migrate.js up` confirma que el esquema quedó en la última versión.

## 5. Rotación de secretos

Rote de inmediato ante cualquier sospecha de exposición, y en forma periódica según la política de la organización (anual como mínimo). Cada rotación queda registrada en el registro de cambios de operación.

| Secreto | Procedimiento | Impacto |
| --- | --- | --- |
| `db_runtime_password` / `db_owner_password` | `dc exec postgres psql -U postgres -d enviotec -c "ALTER ROLE app_runtime PASSWORD '<nueva>'"` (o `app_owner`); actualizar el archivo y la URL (`database_url` / `migration_database_url`); `dc up -d --force-recreate backend worker` | Reinicio breve del backend y del worker |
| `postgres_password` | `ALTER ROLE postgres PASSWORD '<nueva>'` y actualizar el archivo | Ninguno |
| `redis_*_password` y `redis_url_*` | Regenerar la contraseña y la URL del mismo usuario; `dc up -d --force-recreate redis backend worker file-processor` (Redis carga los usuarios ACL al arrancar) | Trabajos en curso se reintentan; los contadores de rate limiting se reinician |
| `csrf_secret` | Reemplazar el archivo; `dc up -d --force-recreate backend` | Los usuarios recargan la página para obtener un token nuevo |
| `data_encryption_key` | Con backend y worker detenidos: `dc stop backend worker`; `dc run --rm -v $PWD/secrets/data_encryption_key:/run/keys/old:ro -v $PWD/nueva_clave:/run/keys/new:ro tools node scripts/rotate-encryption-key.js --old /run/keys/old --new /run/keys/new`; reemplazar el secreto por la clave nueva; `dc up -d --wait` | Ninguno para los usuarios: los MFA siguen funcionando. La rotación es atómica y se audita (`security.key_rotation`) |
| `tls_cert` / `tls_key` | Reemplazar los archivos antes del vencimiento; `dc up -d --force-recreate nginx` | Ninguno |
| Keys de Mandrill (sistema y campañas) | Crear la nueva en Mandrill, reemplazar el secreto, `dc up -d --force-recreate backend worker`, verificar un envío de prueba y **eliminar la anterior en Mandrill** | Ninguno |
| Contraseña de bind de LDAP | Cambiarla en AD, reemplazar el secreto, `dc up -d --force-recreate backend worker` | Logins de AD fallan entre ambos pasos: hacerlo en una ventana corta |

## 6. Revocación masiva de sesiones

Ante un incidente (robo de credenciales, sesión comprometida, cambio de configuración de seguridad):

```bash
dc run --rm tools node scripts/revoke-sessions.js --reason "Incidente <id>"                  # todas
dc run --rm tools node scripts/revoke-sessions.js --reason "Cuenta comprometida" --user <uuid> # una cuenta
```

- La revocación es inmediata: el backend valida la sesión en PostgreSQL en cada request.
- Se audita como `session.mass_revoke`, con el motivo y la cantidad.
- **Cuenta comprometida:**
  1. desactive la cuenta desde *Usuarios*, lo que también revoca sus sesiones;
  2. si tenía MFA, emita un código de enrolamiento nuevo (`users.reset_mfa`);
  3. revise la auditoría por actor desde la fecha sospechada;
  4. cancele o pause las campañas que haya enviado o aprobado.

## 7. Monitoreo y operación periódica

| Tarea | Frecuencia | Cómo |
| --- | --- | --- |
| Salud del stack | Continua | `dc ps` (healthchecks) y `GET /health/ready` desde el monitoreo de la organización |
| Verificación de la cadena de auditoría | Diaria | `dc run --rm tools node scripts/audit-verify.js --from <ayer>`; un código de salida 2 es un incidente de seguridad |
| Particiones mensuales | Diaria (automática) | El worker crea 12 meses por adelantado. Alertar si el log del worker muestra `partitions` con error |
| Firmas de ClamAV | Automática | `freshclam` actualiza a través del proxy de egreso. Verificar que el healthcheck de `clamav` esté sano: sin firmas, el pipeline de archivos rechaza todo |
| Revisión de cuentas locales | Mensual | Pantalla *Usuarios → Revisión* (último acceso y vencimiento), por auditoría |
| Revisión de accesos y roles | Trimestral | Roles con permisos administrativos y sus usuarios; grupos de AD mapeados |
| Uso del tope global y de cuotas | Semanal | Pantalla *Cuotas* |
| Espacio en disco | Semanal | `docker system df -v`; el volumen `filestore` crece con cada campaña |
| Logs técnicos | Continua | Docker rota los logs (`max-size` y `max-file` en `docker-compose.yml`). Para la retención de 12 meses (Parte B), envíe los logs al sistema central de la organización (`journald`, `syslog` o un agente) y archívelos en frío al vencer |
| Prueba de restauración | Trimestral | Sección 4 |

## 8. Red hacia el controlador de dominio (R17)

Las redes del backend y del worker son internas. Para LDAPS en producción, agregue un archivo `docker-compose.ad.yml`, versionado junto al despliegue:

```yaml
services:
  backend:
    networks: [edge, data, egress, directory]
  worker:
    networks: [data, egress, directory]
networks:
  directory:
    driver: bridge
```

- En el firewall del host, la red `directory` solo puede salir hacia la IP del controlador de dominio, puerto 636.
- Levante el stack con `docker compose -f docker-compose.yml -f docker-compose.ad.yml up -d --wait`.
- Variables (`.env.example`):
  - `LDAP_URL=ldaps://<dc>`;
  - `LDAP_CA_CERT_FILE`, como secreto con la CA interna;
  - `LDAP_BIND_DN` y `LDAP_BIND_PASSWORD_FILE`, de una cuenta de servicio **de solo lectura**;
  - `LDAP_BASE_DN`;
  - `LDAP_ALLOWED_GROUP_DN`.

## 9. Validación con el AD real (R15)

Antes de habilitar las cuentas de AD, con una cuenta de prueba de la organización:

1. Login con usuario y contraseña de AD → cuenta creada por JIT, con el área según `department`.
2. Usuario fuera del grupo habilitado → no puede ingresar, con la misma respuesta que con credenciales inválidas.
3. Cuenta deshabilitada en AD → pierde la sesión en menos de 15 minutos.
4. Dos contraseñas incorrectas → EnvioTec bloquea la cuenta 15 minutos y AD **no** la bloquea.
5. Grupos anidados y atributos con acentos: confirmar el mapeo a roles de negocio.
6. Certificado: con una CA incorrecta, la conexión se rechaza.
7. MFA: el administrador emite el código de enrolamiento y el usuario configura el TOTP.

## 10. Puesta en marcha del envío (spike 0.5)

Ningún correo real sale de EnvioTec hasta completar estos pasos:

1. **DNS del subdominio de envío:** SPF con el include de Mandrill, DKIM verificado en Mandrill y DMARC alineado (`p=quarantine` o más estricto) (R13).
2. **Keys de Mandrill:** una de campañas y una de sistema, separadas y restringidas a las llamadas necesarias.
   - Secretos `mandrill_campaigns_api_key` (solo el worker, `MANDRILL_CAMPAIGNS_API_KEY_FILE`) y `mandrill_system_api_key` (backend y worker, con `MAIL_FROM` del subdominio).
3. **Spike, con el buzón de prueba que confirme el negocio**, sin otros destinatarios:
   - R2: un lote con `merge_vars` devuelve un `_id` por destinatario;
   - R6: un valor `{{x}}` o `<b>` en un atributo llega escapado y literal;
   - R1: `messages/search` por `u_campaign_id` y `u_batch_id`, límites de frecuencia y retención;
   - R3: la conciliación encuentra un lote por metadata;
   - R4: los encabezados `List-Unsubscribe` y `List-Unsubscribe-Post` (baja con un clic) y el enlace de baja de Mandrill;
   - aperturas y clics se sincronizan; un rebote o una queja de prueba llega a supresión.
4. Registrar los resultados en `docs/spikes/` y actualizar ADR-005, ADR-013 y ADR-024.
5. Solo entonces, crear la primera campaña real con una lista interna pequeña.

## 11. Respuesta ante abuso de envío

| Situación | Acción |
| --- | --- |
| Campaña aprobada por error | *Campañas → Cancelar*. Libera la cuota reservada; los lotes pendientes no se envían |
| Campaña en curso que debe detenerse | *Pausar* (reanudable) o *Cancelar*. Lo ya aceptado por Mandrill no se puede retirar |
| Sospecha de envío masivo no autorizado | Bajar el tope global en *Parámetros* (pausa las campañas al alcanzarlo), revocar sesiones (sección 6) y revisar la auditoría de `campaign.*` |
| Key de Mandrill expuesta | Eliminarla en Mandrill de inmediato y rotar (sección 5) |
| Queja del proveedor por spam | Revisar la campaña, la lista de origen y la supresión; Mandrill puede suspender la cuenta |
