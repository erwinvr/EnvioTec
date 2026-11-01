# ADR-018: Etapas de la sesión, rutas autenticadas y auditoría desde la Fase 3

- **Estado:** Aceptado (2026-10-31)
- **Fecha:** 2026-10-31

## Contexto

El login tiene pasos intermedios: verificar el MFA, cambiar la contraseña inicial (A5) y configurar el MFA obligatorio (Parte B). Mientras falte un paso, la sesión no debe poder usar sus permisos. Además, algunas rutas no corresponden a un permiso del catálogo, porque cada usuario actúa sobre su propia cuenta: `me`, `logout`, sus sesiones, cambio de contraseña y re-autenticación. A6 exige que toda ruta declare su permiso o sea pública. Por último, A7 exige auditar el login, el bloqueo y los cambios de contraseña y de MFA en la misma transacción que la acción. La Fase 4 llegaría tarde para eso.

## Decisión

- **Etapas** calculadas en cada request (`core/auth/stage.js`): `mfa_verify`, `password_change`, `mfa_enroll` y `full`, en ese orden. Mientras la sesión no esté en `full`, sus permisos son un conjunto vacío.
  - Cada ruta declara las etapas que acepta en `config.stages`; por defecto, solo `full`.
  - Fuera de su etapa, la ruta responde 403 con `AUTH_STEP_REQUIRED` y la etapa en `details`.
  - Una ruta con permiso solo admite `full`, y el route guard lo verifica al arrancar.
- **Tercera declaración de ruta:** `config.authenticated: true`, válida para rutas sobre la propia cuenta. Exige sesión válida y CSRF, pero no un permiso.
  - El guard sigue exigiendo exactamente una declaración entre `public`, `permission` y `authenticated`.
  - La superficie pública es una lista cerrada que verifica `route-inventory.test.js`.
- **Auditoría en esta fase:**
  - `append_audit_log()`, en la base y `SECURITY DEFINER`, toma un advisory lock por transacción, lee el hash anterior y calcula el nuevo con `audit_log_canonical()`. Así la cadena se arma en la base y dos inserciones concurrentes nunca comparten `prev_hash`.
  - El servicio de auditoría (`core/audit`) recibe el cliente de la transacción de la acción.
  - Desde ya se auditan todos los 403, el bootstrap y los vencimientos de sesión.
  - En la Fase 4 quedan el script de verificación de la cadena, la consulta, la exportación y la alerta de la cuenta de emergencia.
- **CSRF:** el token es un HMAC del hash de la sesión, así que no se guarda nada extra; cambia cada vez que el token de sesión se regenera. El header `Origin` se verifica en todo método que modifica estado, incluidas las rutas públicas (login CSRF).

## Alternativas descartadas

- **Sesión "parcial" en otra tabla o en Redis:** duplica el modelo de sesión y su revocación.
- **Un permiso `self.*` asignado a todos los roles:** un usuario sin roles no podría ni cerrar sesión, y el permiso no aporta control real.
- **Calcular el hash de auditoría en Node:** exige reproducir en otro lugar el formato de `occurred_at` y del JSONB. En la base, el mismo código sirve para insertar y para verificar.

## Consecuencias

- El advisory lock serializa las transacciones que auditan. Con 100 usuarios concurrentes el costo es bajo; si se vuelve un cuello de botella, la cadena puede particionarse por mes.
- La Fase 4 se reduce a verificación, consulta, exportación y alertas.
