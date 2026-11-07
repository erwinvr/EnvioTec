# ADR-026: `areas.view_all` amplía la lectura, no la escritura

- **Estado:** Aceptado (pedido por el usuario el 2026-11-03)
- **Fecha:** 2026-11-03

## Contexto

Un usuario con los roles `operador` y `reportes` pudo elegir otra área al crear una plantilla. `reportes` incluye `areas.view_all`, y el alcance por área (ADR-008) lo aplicaba a todo: leer, crear, modificar y aprobar.

La Parte B dice que operadores y aprobadores trabajan solo en su área, y que `areas.view_all` es para *ver* (administración, auditoría y reportes). Con dos roles combinados, un operador podía crear o modificar datos de cualquier área. Un aprobador con reportes podía aprobar campañas de cualquier área, con lo que el control maker-checker dejaba de limitarse a cada área (T22, ASVS V8.2).

## Decisión

- **`areaScopeFor`** (lectura) sigue dando alcance global con `areas.view_all`.
- **`writeScopeFor`** (escritura) es siempre el área del propio usuario. Lo usan las modificaciones de datos de negocio:
  - plantillas: crear, editar, archivar y subir versión;
  - listas y contactos: crear, editar, borrar e importar;
  - campañas: crear (la lista debe ser del área propia), editar, borrar y subir el PDF;
  - flujo de campañas: enviar a aprobación, aprobar, rechazar, reanudar y enviar prueba.
- **Registro visible pero de otra área:** responde **403** (`AREA_WRITE_DENIED`) y se audita como `authorization.area_deny`. Sin `areas.view_all`, el registro de otra área sigue respondiendo **404**, para no revelar que existe.
- **Excepción:** **pausar y cancelar** usan el alcance de lectura. Solo detienen envíos, y el runbook los usa para frenar una campaña abusiva de cualquier área.
- **Fuera de este cambio:** la administración que ya es global por permiso propio (`senders.manage`, `users.*`, `quotas.manage`, `areas.manage`, `suppressions.manage`) no cambia.
- **Frontend:** los formularios de plantillas y listas ya no muestran el selector de área. El formulario de campaña ofrece solo plantillas, listas y remitentes del área propia.

## Alternativas descartadas

- **Prohibir combinar roles con `areas.view_all` y permisos de escritura:** dejaría la regla en la configuración de roles, que un administrador puede cambiar, y no en el código.
- **Permiso nuevo `areas.write_all`:** la Parte B no lo pide y reabre el riesgo.

## Consecuencias

- Un operador puede tener también el rol `reportes`: ve los reportes de todas las áreas y crea solo en la suya.
- El superadmin también modifica solo en su área, salvo pausar y cancelar.
