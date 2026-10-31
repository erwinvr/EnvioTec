# ADR-010: PostgreSQL 18, UUIDv7 y particionado mensual

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

A4 pide UUID (v7 si es posible) y la Parte B pide retención perpetua con tablas de alto volumen particionadas por mes. PostgreSQL 18 incluye `uuidv7()` de forma nativa.

## Decisión

- PostgreSQL 18, imagen fijada por versión.
- PK con `uuidv7()` nativo, sin librería.
- Particionado mensual por rango en `campaign_recipients`, `message_events` y `audit_logs`. La clave de partición forma parte de la PK.
- El worker crea particiones con varios meses de anticipación; una alerta avisa si falta la del mes siguiente.

## Alternativas descartadas

- **`pg_partman`:** extensión adicional; la creación de particiones es simple de hacer desde el worker.
- **UUIDv4:** sin orden temporal, peor localidad en índices.

## Consecuencias

- Las migraciones crean las particiones iniciales; la verificación de A11 incluye aplicarlas y revertirlas.
- La cadena de hash de `audit_logs` es global, no por partición.
