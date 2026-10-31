# ADR-012: Vista previa aislada con CSP propia

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

La vista previa de plantillas debe mostrarse en un `iframe` con `sandbox`. La CSP global de A8 incluye `frame-ancestors 'none'`, que impide enmarcar cualquier respuesta, y `style-src 'self'`, mientras que el HTML de correo necesita estilos inline. Con Trusted Types, `iframe.srcdoc` es un sink de HTML y no se puede usar con datos dinámicos.

## Decisión

- La vista previa se sirve desde `GET /api/v1/templates/:id/versions/:version/preview` (requiere `templates.view` y alcance por área) con headers propios: `Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'`, `X-Content-Type-Options: nosniff` y `Cache-Control: no-store`.
- El frontend la carga con `<iframe sandbox src="…">`, sin `allow-scripts` ni `allow-same-origin`. No se usa `srcdoc`.
- Las imágenes inline se sirven como `data:` dentro de la vista previa.
- La excepción de headers se limita a esa ruta, en un bloque `location` propio de Nginx.

## Alternativas descartadas

- **`srcdoc`:** sink de Trusted Types.
- **Mostrar el HTML en la página principal:** expone la app a cualquier XSS que pase la sanitización.

## Consecuencias

- Doble defensa: sanitización en el servidor y aislamiento en el navegador.
