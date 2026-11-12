# EnvioTec — Manual de despliegue

Cómo instalar EnvioTec desde cero en un **ambiente de desarrollo** y en un **ambiente de producción**. La operación diaria posterior (actualizaciones, respaldos, rotación de secretos, incidentes) está en [runbook.md](runbook.md).

Todos los comandos se ejecutan desde la raíz del repositorio.

## Contenido

1. [Diferencias entre los ambientes](#1-diferencias-entre-los-ambientes)
2. [Ambiente de desarrollo](#2-ambiente-de-desarrollo)
3. [Ambiente de producción](#3-ambiente-de-producción)
4. [Problemas frecuentes](#4-problemas-frecuentes)

---

## 1. Diferencias entre los ambientes

Los dos ambientes usan los mismos contenedores y la misma red interna. Cambia lo que agrega `docker-compose.override.yml`, que Docker Compose aplica **solo** cuando se ejecuta `docker compose` sin `-f`.

| Aspecto | Desarrollo | Producción |
| --- | --- | --- |
| Archivos de Compose | `docker-compose.yml` + `docker-compose.override.yml` (automático) | Solo `docker-compose.yml` + los archivos propios del despliegue (sección 3.4) |
| `NODE_ENV` | `development` | `production` |
| Código del backend | Montado desde `backend/src`, con recarga automática (`--watch`) | Copiado en la imagen |
| Logs | `debug`, legibles | `info`, JSON |
| PostgreSQL y Redis | Publicados en `127.0.0.1:5432` y `127.0.0.1:6379` | Sin puertos publicados |
| Secretos | Aleatorios, generados con `npm run secrets:dev` | Generados por el operador (sección 3.3); nunca los de desarrollo |
| Certificado TLS | Autofirmado (`CN=localhost`) | Emitido por la CA interna para el nombre del servidor |
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
| `openssl` | Cualquiera reciente | Generar los secretos y el certificado |
| `git` | Cualquiera reciente | Clonar el repositorio |
| Memoria | 6 GB libres como mínimo | ClamAV solo usa hasta 2 GB |

### 2.2 Instalación inicial

1. **Clonar e instalar las herramientas de lint:**

   ```bash
   git clone <url-del-repositorio> EnvioTec && cd EnvioTec
   npm ci
   ```

2. **Generar los secretos de desarrollo** (contraseñas aleatorias y certificado autofirmado en `./secrets`, que Git ignora):

   ```bash
   npm run secrets:dev
   ```

3. **Crear el archivo de la key de campañas.** El override de desarrollo lo declara como secreto del worker, y Compose no arranca si el archivo no existe. Vacío, el envío queda deshabilitado:

   ```bash
   touch secrets/mandrill_campaigns_api_key
   ```

4. **Configurar el origen** solo si va a entrar desde otra máquina. Cree `.env` (Git lo ignora) con la URL exacta que usará el navegador; si no coincide, el backend rechaza los formularios por CSRF:

   ```bash
   echo 'APP_ORIGIN=https://192.168.200.103' > .env      # IP o nombre del equipo de desarrollo
   ```

   Las demás variables y sus valores por defecto están en [.env.example](../.env.example).

5. **Levantar el stack.** La primera vez tarda varios minutos, porque ClamAV descarga sus firmas antes de quedar sano:

   ```bash
   docker compose up -d --build --wait
   docker compose ps          # todos los servicios en "healthy" o "running"
   ```

6. **Crear la base de datos y los datos iniciales:**

   ```bash
   docker compose run --rm tools node scripts/migrate.js up      # esquema (usuario app_owner)
   docker compose run --rm tools node scripts/seed.js system     # permisos, roles y parámetros
   docker compose run --rm tools node scripts/seed.js dev        # áreas de ejemplo
   ```

7. **Crear el superadministrador.** El script pide usuario, email, nombre, área (la crea si no existe) y contraseña, sin mostrarla:

   ```bash
   docker compose run --rm -it tools node scripts/bootstrap-admin.js
   ```

   Opcionalmente, la cuenta de emergencia: `... bootstrap-admin.js --emergency`.

8. **Entrar:** abra `https://localhost` (o la URL de `APP_ORIGIN`). El navegador advierte sobre el certificado autofirmado: acéptelo o importe `secrets/tls_cert`. En el primer ingreso, el superadmin configura el MFA (TOTP) y guarda sus códigos de recuperación.

9. **Comprobar la salud:**

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
npm run check                                    # verificación completa (stack aislado, no toca el de desarrollo)
docker compose down                              # detener, conservando los datos
docker compose down -v                           # detener y borrar la base, Redis y los archivos
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

> **Cuidado:** `npm run secrets:dev -- --force` borra el directorio `secrets/` completo, incluida la key de Mandrill. Vuelva a crearla después.

### 2.5 Regenerar los secretos o empezar de cero

```bash
npm run secrets:dev -- --force
touch secrets/mandrill_campaigns_api_key
docker compose down -v                 # PostgreSQL solo lee las contraseñas al crear su volumen
docker compose up -d --build --wait
```

Después, repita los pasos 6 a 8 de la sección 2.2.

---

## 3. Ambiente de producción

En producción se usa **siempre** `-f docker-compose.yml`, para que el override de desarrollo nunca se aplique. Defina un alias en la sesión del operador:

```bash
alias dc='docker compose -f docker-compose.yml'
```

Si usa los archivos adicionales de la sección 3.4, agréguelos al alias, por ejemplo `-f docker-compose.yml -f docker-compose.mandrill.yml -f docker-compose.ad.yml`.

### 3.1 Requisitos del servidor

| Requisito | Detalle |
| --- | --- |
| Sistema | Linux x86_64 con Docker Engine 24 o superior y Compose 2.24 o superior. No requiere Node.js |
| Recursos | 4 vCPU, 8 GB de RAM y disco SSD para la base y los archivos (los límites de los contenedores suman unos 6 GB) |
| Usuario operador | Cuenta personal del grupo `docker`, no root. El repositorio y `secrets/` le pertenecen |
| Nombre y certificado | Un nombre DNS interno (por ejemplo `enviotec.empresa.local`) y un certificado de la CA interna con ese nombre en el `subjectAltName` |
| Red de entrada | Solo la red interna llega a los puertos 443 y 80 (80 solo redirige a https). Ningún otro puerto se expone |
| Red de salida | Solo el proxy de egreso sale a internet, hacia `mandrillapp.com` y `database.clamav.net` (sección 3.5) |
| Active Directory | Si se usa: el puerto 636 (LDAPS) del controlador de dominio, alcanzable desde el servidor |
| Respaldos | Un destino fuera del servidor, cifrado y con acceso restringido (runbook, sección 4) |

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
EOF
```

Si la subred `172.31.10.0/24` ya se usa en su red, cambie `EDGE_SUBNET` y `NGINX_IP` (la IP de nginx debe estar dentro de la subred).

### 3.3 Generar los secretos

Cada secreto es un archivo, sin salto de línea final, en `SECRETS_DIR`. **No use `npm run secrets:dev`**: genera un certificado autofirmado.

Permisos: el directorio es `700` y solo el operador puede entrar. Los archivos son `644`, porque Docker Compose (fuera de Swarm) monta los secretos con los permisos del host, y los contenedores leen con usuarios sin privilegios (`postgres`, `node`, `nginx`). Con `600` PostgreSQL no arranca.

```bash
mkdir -p secrets && chmod 700 secrets
write() { printf '%s' "$2" > "secrets/$1"; chmod 644 "secrets/$1"; }
hex() { openssl rand -hex 32; }

pg=$(hex); owner=$(hex); runtime=$(hex); rb=$(hex); rw=$(hex); rf=$(hex)
write postgres_password "$pg"
write db_owner_password "$owner"
write db_runtime_password "$runtime"
write database_url "postgres://app_runtime:${runtime}@postgres:5432/enviotec"
write migration_database_url "postgres://app_owner:${owner}@postgres:5432/enviotec"
write redis_backend_password "$rb"
write redis_worker_password "$rw"
write redis_files_password "$rf"
write redis_url_backend "redis://backend:${rb}@redis:6379/0"
write redis_url_worker "redis://worker:${rw}@redis:6379/0"
write redis_url_files "redis://files:${rf}@redis:6379/0"
write csrf_secret "$(openssl rand -base64 48 | tr -d '\n')"
write data_encryption_key "$(openssl rand -base64 32 | tr -d '\n')"
unset pg owner runtime rb rw rf
```

Certificado de la CA interna, con la cadena intermedia a continuación del certificado del servidor:

```bash
cp /ruta/enviotec.empresa.local.fullchain.pem secrets/tls_cert
cp /ruta/enviotec.empresa.local.key secrets/tls_key
chmod 644 secrets/tls_cert secrets/tls_key
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
    secrets: [database_url, redis_url_backend, csrf_secret, data_encryption_key, mandrill_system_api_key]
  worker:
    environment:
      MANDRILL_SYSTEM_API_KEY_FILE: /run/secrets/mandrill_system_api_key
      MANDRILL_CAMPAIGNS_API_KEY_FILE: /run/secrets/mandrill_campaigns_api_key
      MAIL_FROM: no-reply@envios.empresa.com
      MAIL_FROM_NAME: EnvioTec
    secrets: [database_url, redis_url_worker, mandrill_system_api_key, mandrill_campaigns_api_key]
secrets:
  mandrill_system_api_key: { file: "${SECRETS_DIR:-./secrets}/mandrill_system_api_key" }
  mandrill_campaigns_api_key: { file: "${SECRETS_DIR:-./secrets}/mandrill_campaigns_api_key" }
```

- La key de sistema envía el correo de recuperación de contraseña y los avisos de vencimiento. La de campañas, solo el worker la tiene (ADR-024).
- Las dos keys son distintas, se crean en Mandrill restringidas a las llamadas necesarias, y se escriben en `secrets/` con permisos `644`.

**Active Directory** (`docker-compose.ad.yml`). Completa la sección 8 del runbook con las variables:

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
    secrets: [database_url, redis_url_backend, csrf_secret, data_encryption_key, ldap_ca_cert, ldap_bind_password]
    networks: [edge, data, egress, directory]
  worker:
    environment: *ldap
    secrets: [database_url, redis_url_worker, ldap_ca_cert, ldap_bind_password]
    networks: [data, egress, directory]
networks:
  directory:
    driver: bridge
secrets:
  ldap_ca_cert: { file: "${SECRETS_DIR:-./secrets}/ldap_ca_cert" }
  ldap_bind_password: { file: "${SECRETS_DIR:-./secrets}/ldap_bind_password" }
```

- `LDAP_BIND_DN` es una cuenta de servicio **de solo lectura**. `ldap_ca_cert` es la CA interna en PEM.
- Los dos archivos se pueden combinar: Compose une las listas `secrets:` y `environment` de cada servicio.
- Antes de habilitar las cuentas de AD, complete la validación de la sección 9 del runbook.

Valide la combinación antes de levantar. El comando no debe mostrar errores, y no imprime los secretos:

```bash
dc config --quiet
```

### 3.5 Firewall del host

Las redes internas de Docker no tienen salida. Las únicas que la tienen son `outbound` (proxy de egreso), `public` (nginx) y, si se usa AD, `directory`. El firewall del host debe limitarlas, como segunda barrera detrás de la allowlist del proxy.

Ejemplo con `iptables` en la cadena `DOCKER-USER`. Ajústelo con el equipo de red antes de aplicarlo y hágalo persistente (por ejemplo con `iptables-persistent`):

```bash
OUT=$(docker network inspect enviotec_outbound -f '{{(index .IPAM.Config 0).Subnet}}')
PUB=$(docker network inspect enviotec_public -f '{{(index .IPAM.Config 0).Subnet}}')
iptables -I DOCKER-USER 1 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -I DOCKER-USER 2 -s "$OUT" -p tcp --dport 443 -j RETURN     # proxy de egreso: solo HTTPS
iptables -I DOCKER-USER 3 -s "$OUT" -p udp --dport 53 -j RETURN      # DNS
iptables -I DOCKER-USER 4 -s "$OUT" -j DROP
iptables -I DOCKER-USER 5 -s "$PUB" -j DROP                          # nginx no inicia conexiones
# Con AD: la red directory solo hacia el controlador de dominio
# DIR=$(docker network inspect enviotec_directory -f '{{(index .IPAM.Config 0).Subnet}}')
# iptables -I DOCKER-USER 6 -s "$DIR" -d <IP-del-DC> -p tcp --dport 636 -j RETURN
# iptables -I DOCKER-USER 7 -s "$DIR" -j DROP
```

Las redes existen después del primer `dc up`. Aplique las reglas y luego verifique la salida (paso 5 de la sección 3.8).

### 3.6 Construir, migrar y levantar

```bash
dc build
dc build tools
dc up -d --wait postgres redis
dc run --rm tools node scripts/migrate.js up
dc run --rm tools node scripts/seed.js system
dc up -d --wait
dc ps
```

ClamAV puede tardar varios minutos en quedar sano la primera vez, porque descarga sus firmas a través del proxy de egreso. Mientras no esté sano, el pipeline de archivos no arranca.

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
2. Salud desde un equipo de la red interna:

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
| Respaldo diario y prueba de restauración | Runbook, sección 4 |
| Actualizar a una versión nueva y revertir | Runbook, sección 3 |
| Rotación de secretos | Runbook, sección 5 |
| Monitoreo periódico | Runbook, sección 7 |

---

## 4. Problemas frecuentes

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `secret ... file not found` al levantar | Falta un archivo en `secrets/` (en desarrollo, a menudo `mandrill_campaigns_api_key`) | Créelo; vacío deshabilita el envío (sección 2.2, paso 3) |
| El backend o el worker no arrancan y el log lista variables | La configuración se valida al arrancar: falta una variable, un valor es inválido o un secreto es débil | Corrija lo que indica el log; nunca muestra valores |
| `postgres` no arranca o `password authentication failed` | Secretos regenerados con el volumen viejo, o archivos con permisos `600` | `chmod 644` en los archivos. Si regeneró las contraseñas, en desarrollo `docker compose down -v`; en producción, `ALTER ROLE` (runbook, sección 5) |
| Los formularios fallan con error de CSRF u origen | `APP_ORIGIN` no coincide con la URL del navegador | Ajuste `.env` y `docker compose up -d backend` |
| `relation ... does not exist` después de actualizar | Faltan migraciones o la imagen `tools` es vieja | `docker compose build tools` y `migrate.js up` |
| Los archivos subidos quedan en "procesando" | ClamAV sin firmas o el file-processor caído | `docker compose ps clamav file-processor` y los logs de `clamav` |
| El worker registra *mandrill unreachable* | El proxy de egreso tiene el DNS viejo o el firewall bloquea la salida | `docker compose up -d --force-recreate egress-proxy` y revisar la sección 3.5 |
| Un cambio del frontend no se ve | El frontend está en la imagen de nginx | `docker compose up -d --build nginx` y recargar sin caché |
| `seed.js dev` se niega a correr | `NODE_ENV=production`: es intencional | En producción no se cargan datos de ejemplo |
