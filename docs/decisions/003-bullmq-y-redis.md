# ADR-003: Worker con BullMQ y Redis con `noeviction` + AOF

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

La Parte B pide un worker con cola para envíos programados, sincronización con Mandrill, procesamiento de archivos, vigencia diaria de cuentas y revisión de AD cada 15 minutos. A2 ya incluye Redis para contadores de rate limiting. BullMQ guarda los trabajos en Redis: si Redis descarta claves por memoria o se reinicia sin persistencia, se pierden trabajos.

## Decisión

- Un servicio `worker` separado del backend, con BullMQ.
- Colas separadas: `send`, `sync`, `files`, `maintenance`, cada una con su concurrencia.
- Un único Redis con `maxmemory-policy noeviction` y AOF activado. Los contadores de rate limiting tienen TTL, por lo que no crecen sin límite.
- Usuarios ACL de Redis por servicio: backend, worker y file-processor, cada uno limitado a las claves y comandos que necesita. El file-processor solo accede a las claves de la cola `files`.
- Los trabajos llevan solo IDs; el estado de negocio vive en PostgreSQL y el worker lo verifica antes de actuar (por ejemplo, que la campaña esté aprobada).

## Alternativas descartadas

- **Dos instancias de Redis:** más operación sin beneficio claro con este volumen.
- **Cola en PostgreSQL (`SKIP LOCKED`):** posible, pero BullMQ ya resuelve reintentos con backoff, trabajos programados y repetitivos.

## Consecuencias

- Si Redis se queda sin memoria, las escrituras fallan (en vez de perder trabajos); se monitorea el uso de memoria.
- El volumen de Redis necesita persistencia y respaldo.
