# ADR-017: Imagen `tools` para migraciones, seeds y bootstrap

- **Estado:** Aceptado (2026-10-31)
- **Fecha:** 2026-10-31

## Contexto

A11 exige que las migraciones corran como un paso separado con `MIGRATION_DATABASE_URL` (usuario `app_owner`), no al arrancar cada réplica. Los seeds y el bootstrap del superadmin necesitan código del backend (catálogo de permisos, hash de contraseñas, configuración), pero `node-pg-migrate` y sus dependencias no deben entrar en la imagen de producción.

## Decisión

- `database/` es un paquete aparte (`node-pg-migrate` 9.0.0 y `pg`), con su propio `package-lock.json`.
- `backend/Dockerfile` se construye desde la raíz del repositorio. Una allowlist en `.dockerignore` deja pasar solo lo que cada imagen necesita, y nunca secretos, `.env`, `node_modules` ni Git. El Dockerfile genera:
  - `runtime`: backend y worker de producción, sin cambios;
  - `tools`: backend y `database/` con sus dependencias de producción.
- El servicio `tools` de Compose está en el perfil `tools`, así que `docker compose up` no lo arranca. Solo está en la red `data` y solo recibe el secreto `migration_database_url`.
- Las migraciones se escriben en SQL explícito (`pgm.sql`) con su reversión. Cada una se ejecuta en una transacción y `node-pg-migrate` toma un advisory lock, por lo que dos ejecuciones simultáneas no se pisan.
- Los permisos de tabla para `app_runtime` se otorgan explícitamente en cada migración (A4), sin `ALTER DEFAULT PRIVILEGES`.
- `npm run check` ejecuta `migrate verify`: aplica todo, revierte todo y vuelve a aplicar sobre la base vacía del entorno de verificación (A11.8).

## Alternativas descartadas

- **Migrar al arrancar el backend:** varias réplicas competirían y el backend necesitaría credenciales de `app_owner`.
- **`node-pg-migrate` en la imagen de producción:** más superficie de ataque sin uso en ejecución.
- **Builders de `node-pg-migrate` en lugar de SQL:** el SQL explícito es más fácil de revisar en auditoría de seguridad y coincide con lo que se ejecuta.

## Consecuencias

- El despliegue tiene un paso explícito: `docker compose run --rm tools node scripts/migrate.js up` y `node scripts/seed.js system`, antes de actualizar backend y worker.
- La imagen `tools` también se escanea con Trivy.
