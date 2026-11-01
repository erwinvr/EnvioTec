# ADR-019: Pruebas de AD con directorio simulado

- **Estado:** Aceptado (2026-10-31)
- **Fecha:** 2026-10-31

## Contexto

En el plan de la Fase 3 se aprobó un contenedor Samba AD DC para probar el proveedor de AD contra un directorio real dentro de `npm run check`. Al implementarlo, el provisionamiento del dominio falló con `PANIC: Security context active token stack underflow` en Alpine (Samba 4.23) y en Debian 13 (Samba 4.22). Falló sin opciones, con `CAP_SYS_ADMIN` y con `--privileged`. El host es un entorno Proxmox (kernel `-pve`), donde Samba no logra cambiar de identidad para aplicar las ACL de sysvol. No hay datos del AD de la organización todavía.

## Decisión

- El proveedor de AD recibe una fábrica de clientes LDAP (`clientFactory`), que en producción crea el cliente `ldapts` con LDAPS y la CA interna.
- Los tests usan dos dobles de esa fábrica:
  - **Unitarios** (`tests/unit/ad-provider.test.js`): escape del filtro, bind con el DN del usuario, contraseña vacía, AD caído, cuenta deshabilitada o vencida, grupo habilitado y filtro con `LDAP_MATCHING_RULE_IN_CHAIN`.
  - **Integración** (`tests/integration/auth-ad.test.js`): PostgreSQL y Redis reales con un directorio simulado que bloquea a los 3 intentos como AD. Cubre la cuenta creada en el primer login, el área por `department`, los roles por grupo, el bloqueo a los 2 intentos sin que AD llegue a 3, las colisiones, el renombrado por `objectGUID`, el origen único y AD caído.
- La interoperabilidad real (TLS contra la CA interna, atributos de AD, grupos anidados) se valida contra el AD de la organización cuando estén sus datos, con un checklist en el runbook (Fase 9).

## Alternativas descartadas

- **Samba con `--privileged`:** no funciona en este host, y en Jenkins tampoco es aceptable.
- **OpenLDAP:** no tiene `objectGUID`, `userAccountControl` ni `LDAP_MATCHING_RULE_IN_CHAIN`, así que simularlos sería tan artificial como el doble, y más costoso.

## Consecuencias

- Riesgo R15 en `security.md`: la compatibilidad con el AD real queda sin verificar hasta tener acceso a él.
- Si más adelante hay un host donde Samba funcione (por ejemplo, el servidor de Jenkins), se puede agregar como prueba adicional sin cambiar el proveedor.
