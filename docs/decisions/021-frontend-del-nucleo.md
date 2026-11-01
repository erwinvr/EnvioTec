# ADR-021: Frontend del núcleo — QR, idioma y verificación en navegador

- **Estado:** Aceptado (2026-10-31)
- **Fecha:** 2026-10-31

## Contexto

La Fase 7 construye el frontend Vanilla JS (A9) sin frameworks ni empaquetador, bajo una CSP estricta con `require-trusted-types-for 'script'`. Hacían falta tres decisiones: cómo mostrar el QR del enrolamiento de MFA, dónde recordar el idioma elegido (español o inglés, Parte B) y cómo verificar el criterio de salida "CSP sin violaciones en consola".

## Decisión

- **QR:** `uqr` 0.1.3 (MIT, sin dependencias, mantenida por unjs) en el backend. `POST /auth/mfa/enroll/start` devuelve el SVG como `data:image/svg+xml;base64`, que el frontend asigna a un `<img>`, permitido por `img-src 'self' data:`. Nunca se inserta marcado en el DOM, y un test verifica que el SVG no tiene scripts ni handlers. `qrcode` se descartó porque arrastra `yargs` 15 y unas 20 dependencias transitivas.
- **Idioma:** cookie `enviotec_lang` (`es` o `en`, `Secure`, `SameSite=Strict`, un año), sin datos sensibles. `localStorage` sigue prohibido por el lint. Si no hay cookie, se usa el idioma del navegador; si tampoco, español.
- **Verificación en navegador:** `e2e/run.mjs` con `playwright-core` 1.64.1 (Apache-2.0, sin dependencias, solo de desarrollo) dentro de la imagen oficial `mcr.microsoft.com/playwright:v1.64.1-noble`, fijada por digest.
  - Corre como paso 8 de `npm run check` contra el stack de verificación.
  - Recorre login, enrolamiento de MFA, cada pantalla del núcleo, el alta de un área y de un usuario, el cambio de idioma y el cierre de sesión.
  - Falla ante cualquier violación de CSP o de Trusted Types (`securitypolicyviolation`), error en consola o error no capturado.
  - Ignora solo el 401 esperado de `GET /auth/me` antes de iniciar sesión.
  - Usa un superadmin efímero creado con el bootstrap no interactivo.
- **Origen del entorno de verificación:** `APP_ORIGIN=https://nginx:8443`, porque el navegador de la prueba abre la app en esa dirección.

## Alternativas descartadas

- **Sin QR, solo el secreto:** más errores de tipeo al enrolar y peor experiencia en el primer login.
- **Generar el QR en el navegador:** exigiría empaquetar una librería para ES Modules nativos o escribir un codificador propio.
- **Verificación manual de la CSP:** no es repetible ni sirve para Jenkins.

## Consecuencias

- La primera ejecución de `npm run check` descarga la imagen de Playwright (alrededor de 1,5 GB).
- El contexto del navegador usa `ignoreHTTPSErrors`, solo en la prueba, porque el certificado del entorno de verificación es autofirmado.
- El chromium de la prueba corre sin sandbox: el seccomp por defecto de Docker no permite los namespaces que necesita. Solo afecta a la verificación.
