# Baseline — Autenticación, sesiones y autorización

> Parte de `docs/baseline.md` (baseline del prompt base), con la misma autoridad. No se modifica sin aprobación explícita.

## A5. Autenticación y sesiones

**Decisión:** sesiones server-side almacenadas en PostgreSQL, con un token opaco en cookie. **No se usa JWT** para la sesión del navegador. JWT solo se considera si la Parte B declara clientes no navegador (apps móviles, integraciones), y en ese caso se documenta en un ADR.

**Sesión:**

- Token aleatorio de al menos 256 bits generado con `crypto.randomBytes`. En la BD se guarda **solo su hash** SHA-256.
- Cookie con prefijo `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict` (o `Lax` justificado), `Path=/`, sin `Domain`.
- **Regenerar** el token al hacer login, al completar MFA y al cambiar privilegios (previene session fixation).
- Timeout por inactividad (por defecto 30 minutos) y timeout absoluto (por defecto 8 horas), ambos configurables por variable de entorno.
- Logout revoca la sesión en el servidor, no solo borra la cookie.
- **Revocar todas las sesiones** del usuario al cambiar o resetear la contraseña, al desactivarlo y al modificar sus roles.
- Endpoint para que un usuario vea y cierre sus sesiones activas.
- Tokens nunca en `localStorage`, `sessionStorage`, URLs ni logs.

**Contraseñas (NIST SP 800-63B):**

- Hashing con **Argon2id**, parámetros según las recomendaciones vigentes de OWASP y configurables. Prohibido MD5, SHA-1 o SHA-256 directos.
- Longitud mínima 12 caracteres, máxima al menos 64. Sin reglas de composición arbitrarias ni expiración periódica forzada.
- Rechazar contraseñas comunes o filtradas (lista local de contraseñas comunes; consulta k-anonymity a Have I Been Pwned solo si la Parte B lo habilita).
- Rehash automático al hacer login si cambian los parámetros de Argon2.
- Contraseña inicial creada por un administrador obliga a cambiarla en el primer login.

**Protección del login:**

- Rate limiting por IP y por cuenta en Redis.
- Bloqueo temporal progresivo por cuenta tras intentos fallidos consecutivos; desbloqueo automático por tiempo o manual por un administrador.
- **Sin enumeración de usuarios:** mismo mensaje, mismo código HTTP y tiempo de respuesta similar exista o no la cuenta (ejecutar un hash ficticio cuando el usuario no existe). Aplica también a recuperación de contraseña.

**MFA:**

- TOTP (RFC 6238) con códigos de recuperación de un solo uso almacenados como hash.
- **Obligatorio** para usuarios con permisos administrativos; opcional para el resto salvo que la Parte B diga otra cosa.
- El secreto TOTP se guarda cifrado con una clave de entorno.

**Re-autenticación** (contraseña o MFA de los últimos 5 minutos) antes de: cambiar contraseña, cambiar email, configurar MFA, asignar roles o permisos, y desactivar usuarios.

**Recuperación de contraseña:** token de un solo uso, hash en BD, expiración de 15 a 30 minutos, invalida todas las sesiones al usarse. Si la Parte B no define envío de correo, se implementa solo el reset por administrador.

**Diseño extensible:** la autenticación se implementa detrás de una interfaz de proveedor, para poder agregar LDAP, SSO por OIDC (Entra ID, Keycloak u otro) u otros orígenes sin tocar la autorización ni la auditoría.

## A6. Autorización (RBAC granular)

**Modelo:** Usuario → Roles → Permisos. **Sin permisos directos sobre usuarios** en el baseline: simplifica la auditoría y la revisión de accesos. Si un proyecto los necesita, se justifica en un ADR.

**Catálogo de permisos.** Formato `<recurso>.<acción>`. Cada módulo declara sus permisos en su archivo `*.permissions.js`, y una migración o seed los sincroniza con la tabla `permissions`. Permisos del núcleo:

```text
users.view   users.create   users.update   users.disable   users.reset_password
roles.view   roles.create   roles.update   roles.delete    roles.assign
permissions.view
sessions.view_any   sessions.revoke_any
audit.view   audit.export
```

**Roles semilla:** `superadmin` (rol del sistema, no editable ni borrable) y un usuario inicial creado por un script de bootstrap que exige definir la contraseña al ejecutarlo. **Sin credenciales por defecto.**

**Aplicación en el backend:**

- Cada ruta declara su permiso de forma explícita: `requirePermission('users.create')`.
- Las rutas públicas se marcan explícitamente como públicas (`public: true`). **Una ruta sin declaración es un error de arranque**, no una ruta abierta.
- 401 cuando no hay sesión válida; 403 cuando hay sesión pero falta el permiso.
- Permisos efectivos cargados por request (o en caché de corta duración que se invalida al cambiar roles).
- **Autorización a nivel de objeto** en el service, no solo en la ruta: verificar que el recurso pertenece al alcance del usuario (previene IDOR). Si la Parte B define alcance por organización, área, sucursal o propietario, se aplica en cada consulta del repository.

**Reglas contra escalamiento de privilegios** (obligatorias, con tests):

1. Un usuario **no puede otorgar permisos que él mismo no tiene**, ni asignar un rol que contenga permisos que él no posee.
2. Un usuario **no puede modificar sus propios roles** ni desactivarse a sí mismo.
3. **No se puede desactivar ni quitar el rol al último superadmin** activo.
4. Los roles de sistema (`is_system`) no se borran ni pierden permisos críticos.
5. Un rol asignado a usuarios no se borra sin reasignación explícita.
6. Todo cambio de roles o permisos revoca las sesiones de los usuarios afectados (o refresca su caché de permisos) y queda auditado.

**Autorización en el frontend:** `auth.hasPermission('users.create')` se usa **solo para mostrar u ocultar** botones, menús y rutas. Nunca se considera un control de seguridad. El frontend obtiene los permisos efectivos desde `GET /api/v1/auth/me`.
