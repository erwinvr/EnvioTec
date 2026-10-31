# ADR-008: Alcance por área y 404 para objetos de otra área

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

Contactos, plantillas, campañas y reportes pertenecen a un área. Cada usuario pertenece a una sola área. A6 dice 403 cuando falta el permiso, pero devolver 403 para un objeto de otra área confirma que existe y permite enumerar recursos.

## Decisión

- Cada consulta de datos de negocio en los repositories recibe un alcance obligatorio: el `area_id` del usuario o "todas" si tiene `areas.view_all`. Un repository sin alcance no compila sus consultas (falla en el arranque o en los tests).
- Usuario sin área y sin `areas.view_all`: sin acceso a datos de negocio.
- Falta de permiso en la ruta → 403 (A6). Objeto fuera del alcance → 404, auditado como `denied` con motivo `out_of_scope`.
- Los registros quedan en su área original aunque el usuario cambie de área.
- La supresión es global, no por área.

## Alternativas descartadas

- **Row Level Security de PostgreSQL:** posible como segunda capa, pero requiere variables de sesión por consulta con el pool; se evalúa en la Fase 9 como defensa en profundidad.

## Consecuencias

- Tests de IDOR entre áreas en cada endpoint de negocio.
