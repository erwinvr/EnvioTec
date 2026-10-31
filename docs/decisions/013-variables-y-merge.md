# ADR-013: Lenguaje de merge y escape de variables

- **Estado:** Aceptado (el lenguaje de merge y el punto de escape se fijan en el spike de la fase 0.5)
- **Fecha:** 2026-10-31

## Contexto

Las plantillas tienen variables que se reemplazan con datos del contacto. Con envío por lotes (ADR-005) el reemplazo lo hace Mandrill con `merge_vars`. No se sabe con certeza si cada lenguaje de merge de Mandrill escapa los valores. La Parte B prohíbe motores de plantillas que ejecuten código.

## Decisión

- Allowlist de variables: campos fijos (`email`, `first_name`, `last_name`) y atributos de la lista, con nombre `^[a-z][a-z0-9_]{0,39}$`. Una variable que no existe en la lista elegida impide enviar la campaña a aprobación.
- Se acepta solo la sintaxis simple de variable; cualquier otra construcción (bloques, helpers, triple llave, condicionales) se rechaza al procesar la plantilla.
- **Opción preferida:** los valores se escapan para HTML en EnvioTec antes de enviarlos como `merge_vars`, y Mandrill solo los inserta. Si el spike confirma que el lenguaje elegido escapa por sí mismo, se evita escapar dos veces.
- El asunto se trata como texto plano: sin HTML y sin caracteres de control.

## Alternativas descartadas

- **Renderizar cada correo en EnvioTec:** obliga a una llamada por destinatario (ADR-005).
- **Motores con lógica:** prohibidos por la Parte B.

## Consecuencias

- El resultado del spike fija el lenguaje de merge y el punto de escape; este ADR pasa a Aceptado con ese dato.
