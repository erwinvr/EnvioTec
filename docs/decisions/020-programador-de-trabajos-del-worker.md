# ADR-020: Programador de trabajos periódicos del worker

- **Estado:** Aceptado (2026-10-31)
- **Fecha:** 2026-10-31

## Contexto

La Fase 5 agrega dos trabajos periódicos: el control de vigencia de las cuentas locales y la revisión de las cuentas de AD cada 15 minutos. Ya existía un tercero, el mantenimiento de particiones. El ADR-003 previó BullMQ para los procesos en segundo plano. Estos trabajos no necesitan cola, prioridades ni reintentos por mensaje: son idempotentes y, si una ronda falla, se repite en la siguiente.

## Decisión

- `core/jobs/scheduler.js`: cada trabajo corre al iniciar el worker y después cada cierto intervalo (particiones: 24 h; vigencia: 1 h; AD: 15 min).
- Cada ronda toma un advisory lock de sesión con el nombre del trabajo (`pg_try_advisory_lock`). Con varias réplicas del worker, solo una ejecuta la ronda y las demás la saltan.
- Los errores se registran en el log y nunca detienen el worker.
- BullMQ se incorpora en la Fase 8 con el envío de campañas, que sí necesita cola, reintentos con backoff, idempotencia por mensaje y programación por fecha.

## Alternativas descartadas

- **BullMQ desde ahora:** suma una dependencia y su operación (colas repetibles en Redis) para tres trabajos que no la necesitan.
- **cron del sistema operativo:** fuera del contenedor, sin acceso a la configuración validada ni al logger.

## Consecuencias

- La precisión del intervalo es la de `setInterval`: suficiente para un control horario y para la revisión de 15 minutos de la Parte B.
- Si un worker se reinicia, la ronda se ejecuta de inmediato; es inocua porque cada paso es idempotente.
