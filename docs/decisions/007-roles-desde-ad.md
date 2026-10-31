# ADR-007: Grupos de AD solo para roles de negocio

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

La Parte B mapea grupos de AD a roles. Si un grupo pudiera otorgar un rol administrativo, un administrador de AD podría escalar privilegios en EnvioTec fuera de la app, sin re-autenticación ni auditoría de EnvioTec, y saltarse las reglas de A6 (por ejemplo, quitarle el rol al último superadmin). El negocio decidió que los administradores siempre son cuentas locales.

## Decisión

- Un rol es administrativo si contiene algún permiso administrativo (lista en `docs/architecture.md`).
- Los roles administrativos solo se asignan a cuentas locales, dentro de la app, con re-autenticación y auditoría. Un trigger en la BD rechaza asignar un rol administrativo a una cuenta `ad` y crear una equivalencia de grupo de AD hacia un rol administrativo, y rechaza agregar un permiso administrativo a un rol que esté mapeado desde AD.
- Las equivalencias grupo → rol (`directory.manage`) solo apuntan a roles de negocio: operador, aprobador, auditoría, reportes.
- Cada cambio de grupos detectado en el login o en la revisión periódica se audita y revoca las sesiones del usuario.

## Alternativas descartadas

- **Todo rol desde AD:** pierde los controles de A6.
- **Ningún rol desde AD:** obliga a asignar a mano roles de negocio a cientos de usuarios.

## Consecuencias

- Los administradores tienen cuentas locales con vigencia y deben renovarse; nadie renueva su propia cuenta, por lo que se necesitan al menos dos administradores activos además de la cuenta de emergencia.
