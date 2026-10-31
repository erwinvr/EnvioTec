# ADR-002: Sesiones server-side en PostgreSQL, sin JWT

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

A5 fija sesiones server-side con token opaco en cookie. La Parte B declara que no hay clientes no navegador ni otros orígenes. Se registra para dejar constancia de que la condición para usar JWT no se cumple.

## Decisión

Token aleatorio de 256 bits (`crypto.randomBytes`), guardado en `sessions` solo como hash SHA-256. Cookie `__Host-` con `HttpOnly`, `Secure`, `SameSite=Strict` y `Path=/`. Timeout por inactividad de 30 minutos y absoluto de 8 horas, configurables. Regeneración del token en login, MFA y cambio de privilegios. Revocación en logout, cambio de contraseña, desactivación, cambio de roles y en la revisión de AD.

## Alternativas descartadas

- **JWT:** no se puede revocar sin una lista de revocación, que es estado server-side de todos modos; no hay clientes que lo justifiquen.
- **Sesiones en Redis:** PostgreSQL ya es la fuente de verdad, permite auditar y no depende de la persistencia de Redis.

## Consecuencias

- Una consulta a PostgreSQL por request para validar la sesión (con índice por hash). Aceptable para 100 usuarios concurrentes.
- `SameSite=Strict` funciona porque todo es mismo origen (ADR-001).
