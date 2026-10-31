# ADR-004: Pipeline aislado de archivos

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

Se suben .docx (plantillas), CSV (contactos) y PDF (adjunto, máximo 5 MB). La Parte B pide procesamiento en un contenedor aislado sin red, antivirus obligatorio y rechazo de contenido activo en PDFs. Con `network_mode: none` estricto el contenedor no puede recibir trabajos ni hablar con ClamAV. El negocio confirmó que se mantienen todos los controles del PDF aunque no lleve datos sensibles, porque el riesgo principal es distribuir malware desde el dominio de la empresa.

## Decisión

- Servicio `file-processor` en la red Docker `files` (`internal: true`), que solo ve Redis (ACL limitada a su cola) y `clamd`. Sin acceso a PostgreSQL, sin credenciales de BD y sin salida a internet. `read_only: true`, `tmpfs` para trabajo temporal, `cap_drop: [ALL]`, `no-new-privileges`, usuario no root, límites de memoria y CPU y timeout por trabajo.
- Los archivos se intercambian por un volumen privado: cuarentena (entrada) y resultados (salida). Nombres generados por el servidor (UUID).
- **Todos los archivos:** tipo validado por contenido, tamaño máximo, SHA-256 y escaneo con ClamAV.
- **PDF:** firma `%PDF`; normalización con `qpdf --qdf --object-streams=disable`; si qpdf falla, se rechaza. Sobre el resultado normalizado, rechazo de cifrado y de `/JS`, `/JavaScript`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`, `/RichMedia` y `/XFA`. Se envía el archivo original aprobado, no el normalizado.
- **.docx:** inspección del directorio central con `yauzl` antes de descomprimir (tamaño total, número de entradas, razón de compresión); rechazo de `vbaProject.bin`, tipos de contenido con macros, `<!DOCTYPE`, relaciones `TargetMode="External"`, `altChunk` y `attachedTemplate`. Conversión con `mammoth` y sanitización con `sanitize-html` (allowlist de etiquetas, atributos y propiedades CSS; enlaces solo `https:` y `mailto:`). Imágenes extraídas como adjuntos inline (cid), con límite de cantidad y peso.
- **CSV:** `csv-parse` en streaming, límite de filas, validación por fila.
- ClamAV con firmas actualizadas por un contenedor `freshclam` que sale por el proxy de egreso (ADR-009).

## Alternativas descartadas

- **`network_mode: none` estricto con intercambio solo por volumen:** obliga a un sondeo de directorios y no permite usar `clamd`.
- **Procesar en el backend:** un archivo malicioso comprometería un proceso con credenciales de BD.
- **Buscar `/JavaScript` byte por byte:** se esquiva con object streams comprimidos o nombres escapados.

## Consecuencias

- Tres contenedores más (file-processor, clamav, freshclam). ClamAV requiere unos 2 GB de RAM para las firmas.
- Si ClamAV no está disponible o las firmas son viejas, los archivos quedan en cuarentena (falla segura).
- La salida del procesador se trata como no confiable: el worker la valida por schema antes de persistirla.
