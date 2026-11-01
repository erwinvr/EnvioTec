# Baseline — Testing

> Parte de `docs/baseline.md` (baseline del prompt base), con la misma autoridad. No se modifica sin aprobación explícita.

## A12. Testing

**Herramientas:** runner nativo `node:test` y `app.inject()` de Fastify para tests HTTP sin levantar puertos. Base de datos y Redis reales en contenedores para integración; nada de mocks de la base de datos en tests de integración.

**Los tests se entregan en cada fase, no al final.** Una fase no está terminada si su código no tiene tests.

| Tipo | Qué cubre |
| --- | --- |
| Unitarios | Services, validators, cálculo de permisos efectivos, reglas anti-escalamiento, helpers de seguridad |
| Integración | Login, logout, sesiones, MFA, usuarios, roles, permisos, auditoría, paginación |
| Seguridad | Ver lista siguiente |

**Tests de seguridad obligatorios:**

- **Test de inventario de rutas:** recorre todas las rutas registradas y falla si alguna no declara permiso ni está marcada como pública.
- **Matriz de autorización:** para cada endpoint protegido, sin sesión → 401; con sesión sin permiso → 403; con permiso → éxito.
- Escalamiento: asignar un permiso que no se tiene, modificar los propios roles, desactivar al último superadmin.
- IDOR: acceder o modificar recursos fuera del alcance del usuario.
- Mass assignment: enviar `status`, `roles`, `password_hash` o campos desconocidos en el body.
- CSRF: petición sin token y con `Origin` ajeno → rechazada.
- Sesión: el token cambia tras login; la sesión revocada no sirve; expira por inactividad y por tiempo absoluto; se revoca al cambiar la contraseña.
- Enumeración: login y recuperación responden igual con usuario existente e inexistente.
- Rate limiting y bloqueo de cuenta.
- Respuestas nunca incluyen `password_hash`, tokens ni stack traces.
- Headers de seguridad presentes en todas las respuestas.
- Auditoría: `UPDATE` y `DELETE` sobre `audit_logs` fallan con el usuario `app_runtime`; la verificación de la cadena de hash detecta un registro alterado.

Si la Parte B contradice algo de la Parte A, señala el conflicto y propón cómo resolverlo antes de continuar.

---
