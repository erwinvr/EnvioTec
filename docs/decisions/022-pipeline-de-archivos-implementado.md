# ADR-022: Implementación del pipeline de archivos aislado

- **Estado:** Propuesto (decidido con la autorización general del 2026-10-31)
- **Fecha:** 2026-11-01

## Contexto

El ADR-004 fijó que los archivos no confiables (CSV, .docx, PDF) se inspeccionan en un contenedor sin base de datos ni internet, con ClamAV. La iteración 8.2 es la primera que recibe archivos, así que hubo que decidir cómo se implementa.

## Decisión

- **Colas BullMQ 6.5.3** (ADR-003):
  - `files`: el backend encola la inspección.
  - `files-results`: el `file-processor` informa el resultado y el worker lo aplica a la base.
  - Los trabajos llevan solo IDs y parámetros no sensibles.
  - Se omite la verificación de versión de BullMQ (`skipVersionCheck`), que usa `INFO`, un comando que el ACL de Redis no permite.
  - Los trabajos periódicos siguen con el programador del ADR-020. El envío de campañas usará también BullMQ.
- **Usuario de Redis `files`:** solo puede tocar las claves `bull:files:*` y `bull:files-results:*`, sin comandos peligrosos. El `file-processor` no ve ninguna otra clave.
- **Volumen privado `filestore`** (`/data/files`), con nombres siempre generados por el servidor (UUID): `incoming/` (cuarentena), `results/` (salida de la inspección) y `stored/` (archivos aprobados). Nginx nunca lo sirve.
- **Límite de tamaño:** se aplica mientras llega la carga, con el SHA-256 calculado en el mismo flujo. Si se excede, no queda ningún resto en disco.
- **ClamAV:** imagen oficial `clamav/clamav:1.5.4`, fijada por digest y en las redes `files` y `egress`.
  - `freshclam` actualiza las firmas solo a través del proxy de egreso, con las consultas DNS desactivadas.
  - Contenedor `read_only` con `cap_drop: ALL`. Solo recupera las capabilities que su init necesita para bajar a su usuario `clamav`.
  - En `npm run check`, las firmas se guardan en el volumen externo `enviotec-clamav-db` para no descargarlas en cada corrida.
- **Inspección del CSV en el `file-processor`:**
  - Primero el antivirus; si ClamAV no responde, el archivo se conserva para el reintento.
  - Después: rechazo de archivos binarios, delimitador `,` o `;`, BOM, encabezado contra los atributos de la lista, validación fila por fila (hasta 100 errores informados), deduplicación dentro del archivo y como máximo 100.000 filas.
  - El original se borra en cuanto hay un resultado. Si fallan todos los reintentos, la importación queda rechazada.
- **Carga en el worker:** upsert por lotes dentro de una sola transacción (todo o nada) e idempotente, porque un resultado repetido encuentra la importación ya terminada.
- **Multipart** (`@fastify/multipart` 10.1.6) registrado solo en el plugin de contactos, con un archivo y ningún otro campo. Nginx admite cuerpos de hasta 12 MB solo en las rutas de carga.

## Consecuencias

- Hay dos servicios nuevos (`file-processor` y `clamav`); ClamAV necesita alrededor de 1,5 GB de memoria.
- La primera corrida de `npm run check` en una máquina nueva descarga unos 300 MB de firmas.
