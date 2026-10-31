# ADR-015: Squid como proxy de egreso

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

ADR-009 decidió que toda salida a internet pasa por un proxy con allowlist de dominios y dejó la elección del software para la Fase 1. Solo se necesitan túneles HTTPS (CONNECT) hacia `mandrillapp.com` y hacia los servidores de firmas de ClamAV, sin inspeccionar TLS.

## Decisión

- **Squid 7.6** sobre Alpine 3.24.3 (imagen propia en `infra/egress-proxy/`, base fijada por digest), sin caché, como usuario no root y con el sistema de archivos de solo lectura.
- Reglas: solo `CONNECT` al puerto 443 de `.mandrillapp.com` y `database.clamav.net`, solo desde redes privadas; todo lo demás se rechaza con 403.
- Es el único servicio en la red `outbound`. Backend y worker lo usan con `HTTPS_PROXY`; las redes `edge`, `data` y `egress` son `internal: true` y no tienen ruta a internet.
- El healthcheck envía una petición HTTP sin túnel y espera un 403: prueba que Squid está aplicando sus reglas.

## Alternativas descartadas

- **Smokescreen (Stripe):** buen diseño para este caso, pero no publica imágenes oficiales con versiones fijadas y habría que compilarlo.
- **Envoy:** mucho más complejo de configurar para una allowlist de dos dominios.
- **Firewall del host por IP:** las IP de Mandrill y del CDN de ClamAV cambian, y la regla quedaría fuera del repositorio.

## Consecuencias

- Licencia GPL-2.0: Squid corre como servicio separado sin modificaciones; no afecta al código de EnvioTec.
- El `fetch` nativo de Node solo respeta `HTTPS_PROXY` con `NODE_USE_ENV_PROXY=1` (o un agente explícito). El cliente de Mandrill (Fase 8.6) configura el proxy de forma explícita y un test lo verifica.
- **Brecha conocida:** Nginx necesita una red no interna para publicar puertos, por lo que técnicamente tiene ruta de salida. En producción se bloquea con una regla de firewall del host (cadena `DOCKER-USER`), documentada en el runbook de la Fase 9.
- Para LDAPS (Fase 3), backend y worker necesitarán una red con ruta al controlador de dominio, restringida por firewall del host a su IP y puerto (ADR-009).
