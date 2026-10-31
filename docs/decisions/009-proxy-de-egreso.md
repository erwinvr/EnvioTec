# ADR-009: Egreso por proxy con allowlist de dominios

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

La Parte B limita la salida a internet a la API de Mailchimp, y la actualización de firmas de ClamAV necesita salir a sus servidores. Docker no filtra por nombre de dominio y las IP de Mandrill y de ClamAV cambian. El negocio eligió un proxy en compose para que el control quede versionado.

## Decisión

- Servicio `egress-proxy` como única salida a internet. Allowlist de dominios: `mandrillapp.com` y los servidores de firmas de ClamAV. Solo HTTPS (CONNECT al puerto 443), sin inspección TLS. Registra cada conexión.
- Backend, worker y freshclam usan el proxy (`HTTPS_PROXY`). El resto de los contenedores no tiene ruta a internet.
- LDAPS al controlador de dominio va directo por la red interna, restringido por firewall del host a su IP y puerto.
- El software concreto (por ejemplo Squid) se elige y justifica en la Fase 1.

## Alternativas descartadas

- **Firewall del host por IP:** las IP cambian y el control queda fuera del repositorio.
- **Sin control de egreso:** un contenedor comprometido podría exfiltrar datos.

## Consecuencias

- Un componente más que mantener; la allowlist se revisa al agregar integraciones.
- El proxy es una dependencia de los envíos: su caída detiene la salida de forma segura.
