# ADR-006: Proveedores de autenticación local y AD

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

Conviven usuarios locales y de Active Directory on-premise (solo LDAPS, sin ADFS). Cada usuario tiene un único origen. A5 pide la autenticación detrás de una interfaz de proveedor. AD bloquea la cuenta a los 3 intentos y reinicia el contador a los 15 minutos. Una cuenta deshabilitada en AD debe perder acceso.

## Decisión

- Interfaz `AuthProvider` con dos implementaciones: `local` (Argon2id) y `ad` (LDAPS). El login elige el proveedor según `users.auth_source`; un usuario nunca se autentica por otro origen. Si el usuario no existe localmente, se intenta AD (JIT) con tiempo de respuesta uniforme.
- **AD:** `ldapts`, solo LDAPS o StartTLS con validación del certificado contra la CA interna. Búsqueda con cuenta de servicio de solo lectura y filtro escapado (RFC 4515); bind con el DN del usuario; contraseñas vacías rechazadas antes de llamar a AD. Se verifica `userAccountControl` (deshabilitada), `accountExpires` y la pertenencia al grupo habilitado (con grupos anidados).
- **JIT:** en el primer login exitoso, si pertenece al grupo habilitado, se crea la cuenta identificada por `objectGUID`. El área sale de `areas.ad_department` (comparación sin mayúsculas); sin coincidencia, entra sin área. Colisión de `username` o email con otra cuenta: se rechaza y se audita.
- **Bloqueo AD:** EnvioTec corta a los 2 intentos fallidos por cuenta de AD y bloquea esa cuenta 15 minutos, para no llegar al umbral de AD. Valores en variables de entorno.
- **Revisión de AD:** el worker revisa cada 15 minutos las cuentas de AD activas; deshabilitada, fuera del grupo, cambio de `department` o de grupos → actualiza, audita y revoca sesiones. También se revisa en cada login y re-autenticación.
- **MFA:** TOTP de la aplicación para administradores y para quien tenga `campaigns.submit` o `campaigns.approve`, también en cuentas de AD.
- **Enrolamiento de MFA en cuentas de AD:** el primer login solo con contraseña no permite configurar el MFA. Un administrador con `users.reset_mfa` (y re-autenticación) emite un código de enrolamiento de un solo uso, ligado al usuario y válido por `mfa.enrollment_code_validity_hours` (por defecto 24 horas, rango 1–72), y lo entrega por otro canal (en persona, por teléfono o por correo interno). El código se muestra una sola vez al administrador y se guarda solo como hash. Hasta enrolar, la cuenta solo ve la pantalla que pide el código. Emisión, uso, vencimiento e intentos fallidos se auditan; los intentos tienen rate limiting. El mismo mecanismo sirve para reconfigurar el MFA si el usuario pierde su dispositivo (al reiniciarlo se revocan sus sesiones).
- Las cuentas locales no lo necesitan: el administrador ya entrega la contraseña inicial por otro canal y el primer login obliga a cambiarla y a configurar el MFA.

## Alternativas descartadas

- **Sincronización masiva de AD:** crea cuentas que nunca se usan; JIT con revisión periódica es suficiente.
- **`sAMAccountName` como identificador:** cambia si se renombra la cuenta.
- **Confiar en el primer uso del MFA (TOFU):** quien conozca la contraseña de AD podría enrolar su propio dispositivo antes que el dueño.
- **Asignar el rol después del enrolamiento:** no elimina el riesgo; el administrador tampoco puede verificar quién enroló.

## Consecuencias

- Hasta 15 minutos de acceso tras deshabilitar una cuenta en AD (riesgo aceptado, ADR-014).
- Un usuario que ya falló en otros sistemas puede quedar bloqueado en AD igual.
- Los administradores dependen de cuentas locales (ADR-007), con vigencia y renovación.
- Cada operador o aprobador de AD necesita que un administrador le emita un código antes de su primer uso.
