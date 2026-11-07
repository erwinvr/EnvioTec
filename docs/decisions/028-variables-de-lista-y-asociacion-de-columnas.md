# ADR-028: Variables de lista y asociación de columnas del CSV

- **Estado:** Aceptado (pedido por el usuario el 2026-11-07)
- **Fecha:** 2026-11-07

## Contexto

Los atributos de una lista eran nombres técnicos escritos como texto al crearla. El CSV tenía que traer encabezados idénticos a esos nombres, y el formulario de contacto mostraba el nombre técnico sin explicar qué variable usa la plantilla. En las pruebas del usuario esto provocó confusión entre el campo fijo *Nombre* (`{{first_name}}`) y un atributo llamado `nombre`.

## Decisión

### Variables por lista

Cada variable tiene un **nombre técnico**, que es el que usa la plantilla (`{{numero_de_poliza}}`), y una **etiqueta** para las personas ("Número de póliza").

- El nombre técnico se propone a partir de la etiqueta (sin tildes, en minúsculas, con `_`) y no cambia después de creado, porque las plantillas dependen de él. La etiqueta sí se puede editar.
- Hay tres campos fijos, el correo, el nombre y el apellido (`{{email}}`, `{{first_name}}` y `{{last_name}}`). Solo el correo es obligatorio; las variables son opcionales por contacto.
- No se crean variables nuevas que repitan un campo fijo en español: `nombre`, `nombres`, `apellido`, `apellidos`, `correo`, `mail` y `e_mail`.
- No se borra una variable mientras algún contacto tenga un valor en ella (`409 variable_in_use`).
- Las variables tienen acciones propias (`POST`, `PATCH` y `DELETE` de `/api/v1/lists/:id/variables`), todas auditadas. El `PATCH` de la lista ya no cambia variables.
- Los atributos que ya existían se convirtieron en variables con una etiqueta derivada del nombre.

### Importación CSV en dos pasos

1. **Subida y vista previa.** El archivo pasa a cuarentena. El `file-processor` aislado (ADR-004) lo revisa con ClamAV y devuelve el encabezado y 3 filas de muestra, con los valores limpios y recortados a 100 caracteres y como máximo 50 columnas. La importación queda en `awaiting_mapping`.
2. **Asociación.** El usuario elige, para cada columna, un campo fijo, una variable o *No importar*.
   - El frontend sugiere la asociación por nombre o etiqueta de la variable, y por los encabezados habituales de los campos fijos, sin distinguir mayúsculas ni tildes.
   - El backend valida que el correo esté asociado y que ningún destino se repita. El `file-processor` lo vuelve a validar contra el encabezado real.
   - La asociación se guarda con la importación y queda auditada (`contacts.import_mapping`).
   - La muestra se borra al confirmar.

Una importación sin asociar se puede cancelar. Si nadie la asocia en 24 horas, vence (`mapping_expired`): el worker borra el archivo y lo audita.

### Pantallas

- La lista muestra la sección *Variables* con la etiqueta y la forma de usarla en la plantilla.
- El formulario de contacto muestra, debajo de cada campo, la variable que le corresponde.

## Alternativas descartadas

- **Variables por área.** El usuario eligió variables por lista.
- **Asociación solo por encabezado exacto,** como antes: obliga a editar el CSV antes de importarlo.
- **Guardar la muestra después de importar:** son datos personales que ya no hacen falta.

## Consecuencias

- Los trabajos del procesador de archivos usan identificadores con el tipo (`preview-…`, `import-…`), porque un mismo archivo pasa por dos trabajos.
- Una importación necesita un paso más del usuario. A cambio, el CSV puede tener cualquier encabezado y columnas que no se importan.
