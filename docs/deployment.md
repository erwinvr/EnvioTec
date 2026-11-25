# EnvioTec — Manual de despliegue

Cómo instalar EnvioTec desde cero en un **ambiente de desarrollo** y en un **ambiente de producción**. La operación diaria posterior (actualizaciones, respaldos, rotación de secretos, incidentes) está en [runbook.md](runbook.md).

La base de datos es el **SQL Server de la organización** (ADR-032), fuera del stack de Docker. EnvioTec usa dos logins de mínimo privilegio, que se crean una sola vez por ambiente con un login administrativo:

- **dueño** (`<base>_owner`): migraciones, seeds y bootstrap;
- **ejecución** (`<base>_runtime`): la aplicación.

Todos los comandos se ejecutan desde la raíz del repositorio.

## Contenido

1. [Diferencias entre los ambientes](#1-diferencias-entre-los-ambientes)
2. [Ambiente de desarrollo](#2-ambiente-de-desarrollo)
3. [Ambiente de producción](#3-ambiente-de-producción)
4. [Problemas frecuentes](#4-problemas-frecuentes)

---

## 1. Diferencias entre los ambientes

Los dos ambientes usan los mismos contenedores y las mismas redes. Cambia lo que agrega `docker-compose.override.yml`, que Docker Compose aplica **solo** cuando se ejecuta `docker compose` sin `-f`.

| Aspecto | Desarrollo | Producción |
| --- | --- | --- |
| Archivos de Compose | `docker-compose.yml` + `docker-compose.override.yml` (automático) | Solo `docker-compose.yml` + los archivos propios del despliegue (sección 3.4) |
| `NODE_ENV` | `development` | `production` |
| Código del backend | Montado desde `backend/src`, con recarga automática (`--watch`) | Copiado en la imagen |
| Logs | `debug`, legibles | `info`, JSON |
| Base de datos | Base `enviotec` en el SQL Server de la organización; se acepta su certificado autofirmado | Base propia en el SQL Server de producción; el certificado **se valida** contra la CA interna (`database_ca_cert`) |
| Redis | Publicado en `127.0.0.1:6379` | Sin puertos publicados |
| Secretos | Aleatorios, generados con `npm run secrets:dev` | Generados por el operador (sección 3.3); nunca los de desarrollo |
| Certificado TLS de nginx | Autofirmado (`CN=localhost`) | Emitido por la CA interna para el nombre del servidor |
| Datos de ejemplo | `seed.js dev` (áreas de ejemplo) | Prohibido: el script se niega con `NODE_ENV=production` |
| Envío por Mandrill | Opcional, solo con la key de campañas en `secrets/` | Keys de sistema y de campañas, después del spike (runbook, sección 10) |
| Active Directory | Deshabilitado (`AD_ENABLED=false`) | Opcional, con `docker-compose.ad.yml` (sección 3.4) |

---

## 2. Ambiente de desarrollo

### 2.1 Requisitos

| Herramienta | Versión | Para qué |
| --- | --- | --- |
| Docker Engine + Compose v2 | Docker 24 o superior, Compose 2.24 o superior | Todo el stack |
| Node.js | 22.13 o superior | Solo en el host, para lint, tests del frontend y `npm run check`. El backend corre en Node.js 26 dentro del contenedor |
| `openssl` | Cualquiera reciente | Generar los secretos y los certificados |
| `git` | Cualquiera reciente | Clonar el repositorio |
| Memoria | 6 GB libres como mínimo (8 GB para `npm run check`, que levanta su propio SQL Server) | ClamAV usa hasta 2 GB |
| SQL Server | 2022 o posterior, alcanzable en el puerto 1433 | Un login administrativo solo para el aprovisionamiento |

### 2.2 Instalación inicial

1. **Clonar e instalar las herramientas de lint:**

   ```bash
   git clone <url-del-repositorio> EnvioTec && cd EnvioTec
   npm ci
   ```

2. **Generar los secretos de desarrollo** (contraseñas aleatorias, URLs de la base y certificado autofirmado en `./secrets`, que Git ignora). `DB_HOST` es el servidor de base de datos:

   ```bash
   DB_HOST=192.168.200.108 npm run secrets:dev
   ```

   Se generan `migration_database_url` (login `enviotec_owner`) y `database_url` (login `enviotec_runtime`), ambas hacia la base `enviotec`.

3. **Escribir la credencial administrativa**, solo para el aprovisionamiento. La escribe quien administra el servidor, directamente en el archivo y sin pegarla en chats ni tickets:

   ```bash
   nano secrets/database_admin_url    # sqlserver://<login administrativo>:<clave>@192.168.200.108:1433/master
   chmod 644 secrets/database_admin_url
   ```

   Si la clave tiene caracteres especiales (`@`, `:`, `/`, `%`), van codificados (`%40`, `%3A`, `%2F`, `%25`).

4. **Crear el archivo de la key de campañas.** El override de desarrollo lo declara como secreto del worker, y Compose no arranca si el archivo no existe. Vacío, el envío queda deshabilitado:

   ```bash
   touch secrets/mandrill_campaigns_api_key
   ```

5. **Configurar el origen** solo si va a entrar desde otra máquina. Cree `.env` (Git lo ignora) con la URL exacta que usará el navegador; si no coincide, el backend rechaza los formularios por CSRF:

   ```bash
   echo 'APP_ORIGIN=https://192.168.200.103' > .env      # IP o nombre del equipo de desarrollo
   ```

6. **Aprovisionar la base** (una vez). Crea la base `enviotec`, los logins dueño y de ejecución y el rol `app_runtime`, y activa read committed snapshot:

   ```bash
   npm run db:provision
   ```

   Después puede borrar `secrets/database_admin_url`: la aplicación no lo usa.

7. **Crear el esquema y los datos iniciales:**

   ```bash
   docker compose build tools
   docker compose run --rm tools node scripts/migrate.js up      # esquema (login dueño)
   docker compose run --rm tools node scripts/seed.js system     # permisos, roles y parámetros
   docker compose run --rm tools node scripts/seed.js dev        # áreas de ejemplo
   ```

8. **Levantar el stack.** La primera vez tarda varios minutos, porque ClamAV descarga sus firmas:

   ```bash
   docker compose up -d --build --wait
   docker compose ps          # todos los servicios en "healthy" o "running"
   ```

9. **Crear el superadministrador.** El script pide usuario, email, nombre, área (la crea si no existe) y contraseña, sin mostrarla:

   ```bash
   docker compose run --rm -it tools node scripts/bootstrap-admin.js
   ```

   Opcionalmente, la cuenta de emergencia: `... bootstrap-admin.js --emergency`.

10. **Entrar:** abra `https://localhost` (o la URL de `APP_ORIGIN`). El navegador advierte sobre el certificado autofirmado: acéptelo o importe `secrets/tls_cert`. En el primer ingreso, el superadmin configura el MFA (TOTP) y guarda sus códigos de recuperación.

11. **Comprobar la salud:**

    ```bash
    curl --cacert secrets/tls_cert https://localhost/health/ready
    ```

### 2.3 Trabajo diario

| Cambio | Qué hacer |
| --- | --- |
| Código de `backend/src` | Nada: backend, worker y file-processor se reinician solos (`--watch`) |
| Frontend (`frontend/`) | `docker compose up -d --build nginx` (el frontend se copia en la imagen de nginx) |
| Migración nueva | `docker compose build tools` y luego `docker compose run --rm tools node scripts/migrate.js up`. La imagen `tools` copia las migraciones al construirse, y `up --build` no la reconstruye porque está en un perfil aparte |
| Permisos o parámetros nuevos | `docker compose run --rm tools node scripts/seed.js system` |
| Dependencias (`package.json`) | `docker compose up -d --build` |

Comandos útiles:

```bash
docker compose logs -f backend worker            # logs
docker compose run --rm tools node scripts/audit-verify.js   # cadena de auditoría
npm run lint && npm run test:frontend            # chequeos rápidos en el host
npm run check                                    # verificación completa, con su propio SQL Server (no toca el de desarrollo)
docker compose down                              # detener; los datos quedan en SQL Server
```

### 2.4 Envío real con Mandrill (opcional)

Sin la key de campañas, las campañas y los envíos de prueba terminan como fallidos con un motivo, y ningún correo sale.

1. Copie la key de campañas **directamente en el archivo**, sin pegarla en chats, tickets ni en la terminal compartida:

   ```bash
   nano secrets/mandrill_campaigns_api_key       # una sola línea, solo la key
   docker compose up -d --force-recreate worker
   ```

2. En *Parámetros*, configure los dominios internos permitidos para envíos de prueba.
3. Envíe primero una prueba a su propio correo. Los destinatarios reales reciben correo de verdad, también desde desarrollo.

### 2.5 Regenerar los secretos

`--force` genera claves nuevas para los logins de la base, para Redis, para el CSRF y un certificado nuevo para nginx. Conserva lo que el script no puede generar y lo que necesitan los datos que ya están en el servidor:

| Se conserva | Motivo |
| --- | --- |
| `mandrill_*_api_key` | Las entrega Mandrill |
| `database_admin_url` | La escribe quien administra SQL Server |
| `data_encryption_key` | Cifra los secretos de MFA guardados en la base: una clave nueva dejaría a todos los usuarios sin poder entrar. Para cambiarla, use `scripts/rotate-encryption-key.js` (runbook, sección 5) |
| `dev_admin_password` | Contraseña del administrador de desarrollo, si existe |

Después hay que cambiar las claves de los logins en el servidor. Para eso hace falta `secrets/database_admin_url`; si se borró después del aprovisionamiento, se vuelve a escribir (paso 3 de la sección 2.2):

```bash
DB_HOST=192.168.200.108 npm run secrets:dev -- --force
npm run db:provision -- --reset-passwords
docker compose up -d --force-recreate
```

Para empezar de cero, el administrador de la base borra la base `enviotec` y los logins `enviotec_owner` y `enviotec_runtime`. Después se repiten los pasos 6 a 9 de la sección 2.2.

### 2.6 Instalación anterior con PostgreSQL

Hasta el 2026-11-24, EnvioTec usaba PostgreSQL en un contenedor (ADR-032). Al actualizar una instalación de esa época:

1. **Los datos no se migran solos.** La base de SQL Server empieza vacía (catálogo, parámetros, áreas de ejemplo y el superadmin que se cree con el bootstrap). Los usuarios configuran el MFA de nuevo.
2. **Los datos anteriores quedan en el volumen `enviotec_pgdata`**, que Docker Compose ya no usa ni borra. Antes de eliminarlo, guarde un respaldo si puede hacer falta consultarlo:

   ```bash
   docker run --rm -v enviotec_pgdata:/data:ro -v "$PWD/backup:/backup" alpine:3.22 \
     tar -czf /backup/pgdata-$(date -u +%Y%m%d).tar.gz -C /data .
   docker volume rm enviotec_pgdata      # solo cuando ya no se necesite
   ```

3. Los secretos de PostgreSQL (`postgres_password`, `db_owner_password`, `db_runtime_password`) ya no se usan y se pueden borrar de `secrets/`.
4. El contenedor `postgres` se elimina con `docker compose down --remove-orphans`.

---

## 3. Ambiente de producción

En producción se usa **siempre** `-f docker-compose.yml`, para que el override de desarrollo nunca se aplique. Defina un alias en la sesión del operador:

```bash
alias dc='docker compose -f docker-compose.yml'
```

Si usa los archivos adicionales de la sección 3.4, agréguelos al alias, por ejemplo `-f docker-compose.yml -f docker-compose.mandrill.yml -f docker-compose.ad.yml`.

### 3.1 Requisitos

| Requisito | Detalle |
| --- | --- |
| Servidor de aplicación | Linux x86_64 con Docker Engine 24 o superior y Compose 2.24 o superior. No requiere Node.js. 4 vCPU, 8 GB de RAM y disco para los archivos (los límites de los contenedores suman unos 5 GB) |
| Usuario operador | Cuenta personal del grupo `docker`, no root. El repositorio y `secrets/` le pertenecen |
| SQL Server | 2022 con la **última actualización acumulativa** instalada (R18), alcanzable desde el servidor de aplicación por el puerto 1433. Lo administra el equipo de base de datos |
| Certificado de SQL Server | Emitido por la CA interna con el nombre del servidor de base en el `subjectAltName` (R19). Con el certificado autogenerado (`SSL_Self_Signed_Fallback`), producción no arranca |
| Login administrativo | Uno nominal del equipo de base de datos, solo para el aprovisionamiento; nunca `sa` con una clave compartida (R20) |
| Nombre y certificado de la aplicación | Un nombre DNS interno (por ejemplo `enviotec.empresa.local`) y un certificado de la CA interna con ese nombre en el `subjectAltName` |
| Red de entrada | Solo la red interna llega a los puertos 443 y 80 (80 solo redirige a https). Ningún otro puerto se expone |
| Subredes de Docker | Un rango que no use la organización ni sus VPN, reservado en `/etc/docker/daemon.json` (`default-address-pools`) antes del primer `up`; si se superpone con el de los usuarios, no pueden llegar a la aplicación (sección 4) |
| Red de salida | El proxy de egreso sale a internet solo hacia `mandrillapp.com` y `database.clamav.net`; la red `database` solo hacia SQL Server, puerto 1433 (sección 3.5) |
| Active Directory | Si se usa: el puerto 636 (LDAPS) del controlador de dominio, alcanzable desde el servidor |
| Respaldos | La base, con las herramientas de SQL Server del equipo de base de datos; los archivos (volumen `filestore`), a un destino fuera del servidor, cifrado y con acceso restringido (runbook, sección 4) |

### 3.2 Preparar el servidor

```bash
git clone <url-del-repositorio> /opt/enviotec && cd /opt/enviotec
git checkout <tag-de-la-versión>          # solo versiones con npm run check en verde
```

Cree `.env` con la configuración del despliegue. No contiene secretos:

```bash
cat > .env <<'EOF'
APP_ORIGIN=https://enviotec.empresa.local
LOG_LEVEL=info
HTTPS_PORT=443
HTTP_PORT=80
SECRETS_DIR=./secrets
DATABASE_SERVER_NAME=sql.empresa.local
EOF
```

- `DATABASE_SERVER_NAME` es el nombre que figura en el certificado de SQL Server. La URL de conexión puede usar la IP o ese mismo nombre.
- Si la subred `172.31.10.0/24` ya se usa en su red, cambie `EDGE_SUBNET` y `NGINX_IP` (la IP de nginx debe estar dentro de la subred).

### 3.3 Generar los secretos

Cada secreto es un archivo, sin salto de línea final, en `SECRETS_DIR`. **No use `npm run secrets:dev`**: genera un certificado autofirmado.

Permisos: el directorio es `700` y solo el operador puede entrar. Los archivos son `644`, porque Docker Compose (fuera de Swarm) monta los secretos con los permisos del host, y los contenedores leen con usuarios sin privilegios (`node`, `nginx`).

```bash
mkdir -p secrets && chmod 700 secrets
write() { printf '%s' "$2" > "secrets/$1"; chmod 644 "secrets/$1"; }
hex() { openssl rand -hex 32; }
# Política de claves de SQL Server: mayúsculas, minúsculas y dígitos, sin
# caracteres que haya que codificar en la URL.
sqlpw() { printf '%sAa1' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 36)"; }

db_host=sql.empresa.local; db=enviotec
owner=$(sqlpw); runtime=$(sqlpw); rb=$(hex); rw=$(hex); rf=$(hex)
write migration_database_url "sqlserver://${db}_owner:${owner}@${db_host}:1433/${db}"
write database_url "sqlserver://${db}_runtime:${runtime}@${db_host}:1433/${db}"
write redis_backend_password "$rb"
write redis_worker_password "$rw"
write redis_files_password "$rf"
write redis_url_backend "redis://backend:${rb}@redis:6379/0"
write redis_url_worker "redis://worker:${rw}@redis:6379/0"
write redis_url_files "redis://files:${rf}@redis:6379/0"
write csrf_secret "$(openssl rand -base64 48 | tr -d '\n')"
write data_encryption_key "$(openssl rand -base64 32 | tr -d '\n')"
unset owner runtime rb rw rf
```

Certificados de la CA interna: el de la aplicación con su cadena, y la CA que firmó el certificado de SQL Server:

```bash
cp /ruta/enviotec.empresa.local.fullchain.pem secrets/tls_cert
cp /ruta/enviotec.empresa.local.key secrets/tls_key
cp /ruta/ca-interna.pem secrets/database_ca_cert
chmod 644 secrets/tls_cert secrets/tls_key secrets/database_ca_cert
```

La credencial administrativa solo para el aprovisionamiento (sección 3.6):

```bash
nano secrets/database_admin_url    # sqlserver://<login administrativo>:<clave>@sql.empresa.local:1433/master
chmod 644 secrets/database_admin_url
```

Reglas:

- Los secretos **nunca** entran al repositorio ni se pegan en tickets o chats.
- Guarde una copia de `data_encryption_key` en el gestor de contraseñas de la organización. Sin ella, los MFA ya configurados no se pueden recuperar.
- Respalde el directorio `secrets/` por separado de la base y con otro custodio.

### 3.4 Archivos de Compose del despliegue

`docker-compose.yml` no habilita Mandrill ni AD. Cada uno se agrega con un archivo propio del despliegue. Estos archivos no contienen secretos: solo los referencian.

**Mandrill** (`docker-compose.mandrill.yml`). Habilítelo solo después del spike de envío (runbook, sección 10):

```yaml
services:
  backend:
    environment:
      MANDRILL_SYSTEM_API_KEY_FILE: /run/secrets/mandrill_system_api_key
      MAIL_FROM: no-reply@envios.empresa.com        # del subdominio de envío verificado
      MAIL_FROM_NAME: EnvioTec
    secrets: [mandrill_system_api_key]
  worker:
    environment:
      MANDRILL_SYSTEM_API_KEY_FILE: /run/secrets/mandrill_system_api_key
      MANDRILL_CAMPAIGNS_API_KEY_FILE: /run/secrets/mandrill_campaigns_api_key
      MAIL_FROM: no-reply@envios.empresa.com
      MAIL_FROM_NAME: EnvioTec
    secrets: [mandrill_system_api_key, mandrill_campaigns_api_key]
secrets:
  mandrill_system_api_key: { file: "${SECRETS_DIR:-./secrets}/mandrill_system_api_key" }
  mandrill_campaigns_api_key: { file: "${SECRETS_DIR:-./secrets}/mandrill_campaigns_api_key" }
```

- Compose une estas listas de `secrets` y de `environment` con las de `docker-compose.yml`.
- La key de sistema envía el correo de recuperación de contraseña y los avisos de vencimiento. La de campañas, solo el worker la tiene (ADR-024).
- Las dos keys son distintas, se crean en Mandrill restringidas a las llamadas necesarias, y se escriben en `secrets/` con permisos `644`.

**Active Directory** (`docker-compose.ad.yml`). Completa la sección 8 del runbook:

```yaml
x-ldap: &ldap
  AD_ENABLED: "true"
  LDAP_URL: ldaps://dc01.empresa.local
  LDAP_CA_CERT_FILE: /run/secrets/ldap_ca_cert
  LDAP_BIND_DN: CN=svc-enviotec,OU=Servicios,DC=empresa,DC=local
  LDAP_BIND_PASSWORD_FILE: /run/secrets/ldap_bind_password
  LDAP_BASE_DN: DC=empresa,DC=local
  LDAP_ALLOWED_GROUP_DN: CN=EnvioTec-Usuarios,OU=Grupos,DC=empresa,DC=local
services:
  backend:
    environment: *ldap
    secrets: [ldap_ca_cert, ldap_bind_password]
    networks: [directory]
  worker:
    environment: *ldap
    secrets: [ldap_ca_cert, ldap_bind_password]
    networks: [directory]
networks:
  directory:
    driver: bridge
secrets:
  ldap_ca_cert: { file: "${SECRETS_DIR:-./secrets}/ldap_ca_cert" }
  ldap_bind_password: { file: "${SECRETS_DIR:-./secrets}/ldap_bind_password" }
```

- `LDAP_BIND_DN` es una cuenta de servicio **de solo lectura**. `ldap_ca_cert` es la CA interna en PEM.
- Antes de habilitar las cuentas de AD, complete la validación de la sección 9 del runbook.

Valide la combinación antes de levantar. El comando no debe mostrar errores, y no imprime los secretos:

```bash
dc config --quiet
```

### 3.5 Firewall del host

Las redes internas de Docker no tienen salida. Las únicas que la tienen son:
- `outbound` (proxy de egreso);
- `public` (nginx);
- `database` (backend, worker y tools hacia SQL Server);
- si se usa AD, `directory`.

El firewall del host debe limitarlas, como segunda barrera detrás de la allowlist del proxy y de los logins de la base.

Ejemplo con `iptables` en la cadena `DOCKER-USER`. Ajústelo con el equipo de red antes de aplicarlo y hágalo persistente (por ejemplo con `iptables-persistent`):

```bash
net() { docker network inspect "enviotec_$1" -f '{{(index .IPAM.Config 0).Subnet}}'; }
OUT=$(net outbound); PUB=$(net public); DB=$(net database); SQL=<IP de SQL Server>
iptables -I DOCKER-USER 1 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -I DOCKER-USER 2 -s "$OUT" -p tcp --dport 443 -j RETURN     # proxy de egreso: solo HTTPS
iptables -I DOCKER-USER 3 -s "$OUT" -p udp --dport 53 -j RETURN      # DNS
iptables -I DOCKER-USER 4 -s "$OUT" -j DROP
iptables -I DOCKER-USER 5 -s "$PUB" -j DROP                          # nginx no inicia conexiones
iptables -I DOCKER-USER 6 -s "$DB" -d "$SQL" -p tcp --dport 1433 -j RETURN
iptables -I DOCKER-USER 7 -s "$DB" -p udp --dport 53 -j RETURN       # DNS, si la URL usa un nombre
iptables -I DOCKER-USER 8 -s "$DB" -j DROP
# Con AD: la red directory solo hacia el controlador de dominio
# DIR=$(net directory)
# iptables -I DOCKER-USER 9 -s "$DIR" -d <IP-del-DC> -p tcp --dport 636 -j RETURN
# iptables -I DOCKER-USER 10 -s "$DIR" -j DROP
```

Las redes existen después del primer `dc run` o `dc up`. Aplique las reglas y luego verifique la salida (paso 5 de la sección 3.8).

### 3.6 Aprovisionar, migrar y levantar

```bash
dc build
dc build tools
COMPOSE_FILE=docker-compose.yml npm run db:provision    # base y logins (una vez)
shred -u secrets/database_admin_url                     # la aplicación no la usa
dc run --rm tools node scripts/migrate.js up
dc run --rm tools node scripts/seed.js system
dc up -d --wait
dc ps
```

- El aprovisionamiento es idempotente: se puede repetir sin efectos (`--reset-passwords` cambia las claves de los logins a las de los archivos actuales).
- Si el equipo de base de datos prefiere crear la base y los logins por su cuenta, el resultado debe ser el mismo:
  - base con collation `Latin1_General_100_CI_AS_SC`, `READ_COMMITTED_SNAPSHOT ON` y `ALLOW_SNAPSHOT_ISOLATION ON`;
  - login dueño como dueño de la base y sin roles del servidor;
  - login de ejecución como usuario de la base, miembro solo del rol `app_runtime`.
- ClamAV puede tardar varios minutos en quedar sano la primera vez, porque descarga sus firmas a través del proxy de egreso. Mientras no esté sano, el pipeline de archivos no arranca.

### 3.7 Cuentas iniciales y configuración

1. **Cuentas:**

   ```bash
   dc run --rm -it tools node scripts/bootstrap-admin.js               # superadmin
   dc run --rm -it tools node scripts/bootstrap-admin.js --emergency   # cuenta de emergencia
   ```

   - Las dos cuentas configuran el MFA en su primer ingreso y guardan sus códigos de recuperación.
   - Las credenciales de la cuenta de emergencia se guardan en sobre cerrado o en una bóveda, con acceso de dos personas.

2. **Configuración en la aplicación**, con el superadmin:

   | Pantalla | Qué configurar |
   | --- | --- |
   | *Parámetros* | `notifications.admin_emails`, dominios de envío y de Reply-To, dominios internos para envíos de prueba, tope global mensual y vigencia de cuentas locales |
   | *Áreas* | Áreas de la organización y su `department` de AD |
   | *Remitentes* | Remitentes permitidos (From y Reply-To) por área, del subdominio de envío |
   | *Roles* | Revisar los roles iniciales y, con AD, mapear los grupos de AD a roles de negocio |
   | *Usuarios* | Cuentas locales con su área y su vigencia |
   | *Cuotas* | Saldo de envíos de cada usuario que crea campañas |

### 3.8 Verificación del despliegue

1. `dc ps`: todos los servicios en `healthy` o `running`, y `tools` sin contenedores activos.
2. Salud desde un equipo de la red interna, que también comprueba la conexión a SQL Server con el certificado validado:

   ```bash
   curl -fsS https://enviotec.empresa.local/health/ready      # con la CA interna instalada
   curl -sI http://enviotec.empresa.local | head -n 1         # 301 hacia https
   ```

3. Cadena de auditoría íntegra: `dc run --rm tools node scripts/audit-verify.js` (código 0).
4. Sin puertos de más: `ss -tlnp` en el host muestra solo 80 y 443 de Docker (además de SSH).
5. Egreso bloqueado: el proxy rechaza un dominio fuera de la allowlist.

   ```bash
   dc exec egress-proxy sh -c "printf 'CONNECT example.com:443 HTTP/1.0\r\n\r\n' | nc -w 3 127.0.0.1 3128 | head -n 1"   # 403
   ```

6. Login con el superadmin, con MFA.
7. Con Mandrill habilitado: un envío de prueba al correo del operador llega (runbook, sección 10).

### 3.9 Después del despliegue

| Tarea | Dónde |
| --- | --- |
| Puesta en marcha del envío real (DNS, keys, spike, metadata de Mailchimp) | Runbook, sección 10 |
| Validación con el AD real | Runbook, sección 9 |
| Respaldo de la base y de los archivos, y prueba de restauración | Runbook, sección 4 |
| Actualizar a una versión nueva y revertir | Runbook, sección 3 |
| Rotación de secretos | Runbook, sección 5 |
| Monitoreo periódico | Runbook, sección 7 |

---

## 4. Problemas frecuentes

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `secret ... file not found` al levantar | Falta un archivo en `secrets/` (en desarrollo, a menudo `mandrill_campaigns_api_key`; en producción, `database_ca_cert`) | Créelo; la key de Mandrill vacía deshabilita el envío (sección 2.2, paso 4) |
| El backend o el worker no arrancan y el log lista variables | La configuración se valida al arrancar: falta una variable, un valor es inválido o un secreto es débil | Corrija lo que indica el log; nunca muestra valores |
| `DATABASE_CA_CERT: es obligatoria en producción` | Producción exige validar el certificado de SQL Server | Coloque la CA en `secrets/database_ca_cert` y `DATABASE_SERVER_NAME` en `.env` |
| `self-signed certificate` o `certificate has expired` | SQL Server usa su certificado autogenerado (R19) o uno vencido | El equipo de base de datos instala un certificado de la CA interna; en desarrollo se acepta el autofirmado |
| `Hostname/IP does not match certificate's altnames` | El nombre del certificado no es el de `DATABASE_SERVER_NAME` | Use el nombre exacto del certificado |
| `Login failed for user '..._runtime'` | Logins sin crear, claves distintas de las de `secrets/` o base inexistente | `npm run db:provision` (o `-- --reset-passwords` si regeneró los secretos) |
| `Failed to connect ... ETIMEOUT` o `ECONNREFUSED` | El firewall o la red no dejan llegar a SQL Server por el 1433 | Revise la sección 3.5 y que el servidor de base acepte conexiones TCP |
| `The ... permission was denied` en un log del backend | Una tabla nueva sin `GRANT` a `app_runtime`, o migraciones sin aplicar | `dc build tools` y `migrate.js up`; cada migración otorga sus permisos |
| El navegador no llega a la aplicación (la página queda cargando y vence), aunque `curl https://localhost/health/ready` en el servidor responde 200 y nginx no registra el pedido | Una subred de Docker (por defecto `172.17.0.0/16` a `172.31.0.0/16`) coincide con la red o la VPN del equipo del usuario: el servidor manda las respuestas a ese bridge de Docker | Compare `ip -4 route` del servidor con la IP del cliente. Reserve para Docker un rango que la organización no use, en `/etc/docker/daemon.json`: `{"default-address-pools": [{"base": "10.250.0.0/16", "size": 24}]}`; reinicie Docker y recree las redes con `docker compose down` y `up -d`. Si cambia `EDGE_SUBNET`, ajuste también `NGINX_IP` en `.env` |
| Los formularios fallan con error de CSRF u origen | `APP_ORIGIN` no coincide con la URL del navegador | Ajuste `.env` y `docker compose up -d backend` |
| Los archivos subidos quedan en "procesando" | ClamAV sin firmas o el file-processor caído | `docker compose ps clamav file-processor` y los logs de `clamav` |
| El worker registra *mandrill unreachable* | El proxy de egreso tiene el DNS viejo o el firewall bloquea la salida | `docker compose up -d --force-recreate egress-proxy` y revisar la sección 3.5 |
| Un cambio del frontend no se ve | El frontend está en la imagen de nginx | `docker compose up -d --build nginx` y recargar sin caché |
| `seed.js dev` se niega a correr | `NODE_ENV=production`: es intencional | En producción no se cargan datos de ejemplo |
