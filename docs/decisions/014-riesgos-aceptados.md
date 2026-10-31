# ADR-014: Riesgos aceptados por el negocio

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

En la Fase 0 el negocio tomó decisiones que dejan un riesgo residual. Se registran para que quede constancia de quién decidió, qué se aceptó y qué control compensa.

## Decisión

| ID | Riesgo aceptado | Control compensatorio |
| --- | --- | --- |
| RA1 | Sin MFA para `contacts.export` y `reports.export`: una cuenta tomada puede exportar datos personales del área (o de todas, con `areas.view_all`) | Permisos explícitos, alcance por área, límite de filas, auditoría de cada exportación |
| RA2 | Eventos de Mandrill posteriores a 30 días no se registran | Polling frecuente; reportes aclaran que la apertura es aproximada |
| RA3 | Una cuenta de AD dada de baja conserva acceso hasta 15 minutos | Revisión en login y re-autenticación; revocación al detectar el cambio |
| RA4 | Un usuario que ya falló en otros sistemas puede quedar bloqueado en AD | Corte a los 2 intentos en EnvioTec; rate limiting por IP |

## Alternativas descartadas

- MFA en exportaciones, webhooks de Mandrill y revisión de AD en cada request: descartadas por el negocio o por la Parte B.

## Consecuencias

- Cualquier cambio en estas decisiones requiere un nuevo ADR.
