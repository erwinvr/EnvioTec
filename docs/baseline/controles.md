# Baseline — Controles transversales y frontend seguro

> Parte de `docs/baseline.md` (baseline del prompt base), con la misma autoridad. No se modifica sin aprobación explícita.

## A8. Controles de seguridad transversales

Cada control debe estar implementado, configurado y cubierto por al menos un test.

| Riesgo | Control obligatorio |
| --- | --- |
| SQL Injection | Solo consultas parametrizadas en repositories. Columnas de ordenamiento y filtros validados contra una **allowlist**, nunca interpolados |
| XSS | Codificación de salida en el frontend (ver A9) + **CSP estricta** |
| CSRF | Cookie `SameSite` **más** token anti-CSRF (synchronizer token ligado a la sesión, enviado en header `X-CSRF-Token`) **más** verificación del header `Origin` en métodos que modifican estado |
| Broken Access Control / IDOR | `requirePermission` en cada ruta + autorización a nivel de objeto en services + test que falla si alguna ruta no declara permiso |
| Mass Assignment | Schemas con `additionalProperties: false`; los services copian solo campos permitidos. Campos como `status`, `roles` o `password_hash` nunca se asignan desde el body genérico |
| Exposición de datos | **Schemas de respuesta** en cada ruta: Fastify serializa solo los campos declarados. `password_hash`, secretos y tokens nunca salen |
| Session fixation / hijacking | Ver A5: regeneración, `__Host-`, `HttpOnly`, `Secure`, timeouts, revocación |
| Brute force / credential stuffing | Rate limiting por IP y por cuenta, bloqueo progresivo, MFA para administradores |
| User enumeration | Respuestas y tiempos uniformes en login, recuperación y alta |
| Path traversal | Sin rutas de archivo construidas con entrada del usuario. Si la Parte B incluye archivos: nombres generados por el servidor, validación de tipo por contenido, almacenamiento fuera del webroot, límite de tamaño |
| SSRF | El baseline no hace peticiones salientes a URLs del usuario. Si la Parte B lo requiere: allowlist de destinos y bloqueo de IPs privadas y metadata |
| DoS de aplicación | Límite de tamaño de body, timeouts de request y de consultas SQL (`statement_timeout`), paginación con tamaño máximo |
| Errores detallados | Error handler central: en producción, mensaje genérico + `request_id`. Sin stack traces, SQL ni rutas internas |
| Proxy confiable | `trustProxy` configurado solo con la IP o red del proxy. Sin esto, la IP auditada y el rate limiting se basan en `X-Forwarded-For` falsificable |
| Secretos | Solo en variables de entorno o Docker secrets; validados al arrancar; la app no arranca si faltan o son débiles |

**Headers de seguridad** (definidos en el backend o en el proxy, en un solo lugar):

```text
Strict-Transport-Security: max-age=63072000; includeSubDomains
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
Cache-Control: no-store   (en respuestas de /api con datos sensibles)
```

La CSP no admite `unsafe-inline` ni `unsafe-eval`. Esto obliga a que no haya scripts, estilos ni handlers (`onclick=`) inline en el HTML.

## A9. Frontend Vanilla JS seguro

Sin frameworks, el frontend no tiene protección automática contra XSS. Por eso estas reglas son obligatorias:

- **Prohibido** usar `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` o `eval` con cualquier dato dinámico. Se usa `textContent` y creación de nodos con un helper central (por ejemplo `el('td', { text: user.email })`).
- Si alguna pantalla necesita HTML enriquecido, se usa DOMPurify con configuración restrictiva, justificado en un ADR.
- Activar **Trusted Types** en la CSP (`require-trusted-types-for 'script'`) si los navegadores objetivo lo soportan.
- Un linter (ESLint con reglas que prohíben los sinks anteriores) falla el build si aparecen.
- Sin scripts ni event handlers inline; todo en módulos ES.
- Sin variables globales; solo `import` y `export`.
- Valores de URL construidos con `URL` y `encodeURIComponent`; nunca enlaces `javascript:`.

**Núcleo del frontend (`src/core/`):**

- **API client** único: envía cookies (`credentials: 'same-origin'`), adjunta el token CSRF, aplica timeout y traduce errores al formato estándar.
- **Manejo de errores centralizado:** 401 → redirige a login; 403 → mensaje de acceso denegado; 409 y 422 → errores de formulario por campo; 429 → mensaje de espera; 500 y 503 → mensaje genérico con el `request_id` para soporte. Nunca se muestran detalles técnicos.
- **Módulo de auth:** `auth.currentUser()`, `auth.hasPermission(code)`, `auth.hasAnyPermission([...])`. Ningún otro módulo consulta permisos por su cuenta.
- **Router** del lado del cliente que verifica permisos antes de mostrar una página (solo UX).

**Componentes reutilizables:** `DataTable` (paginación, orden y filtros del lado del servidor), `Form` (validación de UX que replica el schema), `Modal`, `ConfirmDialog`, `Toast`, `Pagination`, `Loader`, `Navigation`. Ninguna página duplica esta lógica.

**Build:** el frontend funciona con ES Modules nativos. Para producción se puede agregar un paso de empaquetado y minificación (por ejemplo esbuild), solo si se justifica.
