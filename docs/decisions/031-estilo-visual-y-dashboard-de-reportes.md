# ADR-031: Estilo visual, menú lateral y dashboard de reportes

- **Estado:** Aceptado (pedido por el usuario el 2026-11-11: "aplica 1, 2, 3 incluye la fuente, cifras del periodo")
- **Fecha:** 2026-11-11

## Contexto

El usuario pidió adoptar el estilo de un dashboard de referencia: paleta violeta, tarjetas con sombra, menú lateral oscuro y un panel de reportes con indicadores, un gráfico de líneas y una dona por dispositivo. Se toma solo el estilo; nombre, logo y contenido siguen siendo los de EnvioTec.

Restricciones que se mantienen (A9): JavaScript Vanilla, sin `innerHTML` ni estilos en línea (CSP `style-src 'self'`, `font-src 'self'`, Trusted Types), sin librerías nuevas sin justificar.

## Decisión

### 1. Estilo general

- Una sola hoja (`frontend/src/styles/main.css`) con variables de color en `:root`. Todas las combinaciones de texto y fondo cumplen WCAG AA (contraste de 4,5:1 o más), verificadas al definir la paleta.
- **Fuente Plus Jakarta Sans** (SIL Open Font License 1.1), servida por la propia aplicación desde `frontend/src/assets/fonts/`, con su licencia en `OFL.txt`. Solo los subconjuntos latin y latin-ext en `woff2` de peso variable, 49 KB en total, tomados del paquete `@fontsource-variable/plus-jakarta-sans` 5.3.0.
  - SHA-256 de `latin`: `153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79`.
  - SHA-256 de `latin-ext`: `38e3b8fd8045048eb311d90170a4429ed2c8f405852dc3d91b5af8452758703f`.
  - No se agrega como dependencia de npm: es un archivo estático que se actualiza a mano. No se carga desde Google Fonts, porque la CSP solo permite fuentes del mismo origen y la aplicación es solo interna.

### 2. Menú lateral

- El menú pasa a una barra lateral agrupada por tarea: Envíos, Contactos, Resultados y Administración. Arriba queda una barra con idioma, usuario (iniciales; no se guardan fotos) y cierre de sesión.
- Sigue mostrando solo lo permitido; como siempre, el backend es el que decide (A6).
- En pantallas de 900 px o menos, el menú se abre con un botón `aria-expanded`. Cerrado, queda `inert` para que sus enlaces no tomen el foco.

### 3. Dashboard de reportes

**Endpoint** `GET /api/v1/reports/overview?from=AAAA-MM-DD&to=AAAA-MM-DD`, con el permiso `reports.view`.

- **Período:** obligatorio, de 1 a 366 días, en días de America/La_Paz. Fuera de rango responde 422 `invalid_period`. Con eso, el costo de la consulta queda acotado.
- **Cifras del período**, sin comparación con el período anterior (decisión del usuario). Se cuentan las campañas que **empezaron a enviarse** en el período, con las mismas cifras por destinatario que el reporte de cada campaña.
- **Serie diaria:** por día, los aceptados por el proveedor y los destinatarios distintos que abrieron o hicieron clic.
- **Dispositivos:** destinatarios distintos que abrieron, por dispositivo: `mobile`, `desktop`, `tablet`, `proxy` o `unknown`. "Proxy" (por ejemplo la precarga de Gmail) se muestra aparte y se explica, para no presentarlo como una lectura.
- **Alcance por área** (ADR-008): las tres consultas parten de las campañas filtradas con `areaCondition`, y `areas.view_all` ve todas las áreas. Los tests de integración comprueban que otra área recibe ceros.
- **Sin datos personales:** solo agregados, así que no hay correos que enmascarar.

**Tarjetas de la pantalla:**
- tasa de entrega, sobre los aceptados;
- apertura, clics, bajas y quejas, sobre los entregados;
- rebotes duros, sobre los aceptados;
- la aclaración de que las aperturas son aproximadas (Parte B) sigue visible.

**Gráficos:** un componente propio (`frontend/src/components/charts.js`) dibuja SVG con `createElementNS` mediante `svg()` de `core/dom.js`.
- `svg()` bloquea `on*`, `style`, `href` y `xlink:href`.
- Los colores salen de clases CSS y las alturas de las barras de 11 clases fijas, así que no hay estilos en línea.
- Las curvas son monótonas: no muestran valores que no existen, por ejemplo bajo cero.
- Cada gráfico tiene nombre accesible y su tabla de datos ("Ver los datos").

El período se guarda en la URL (`#/reportes?desde=…&hasta=…`), y por defecto son los últimos 30 días.

## Alternativas descartadas

- **Una librería de gráficos** (Chart.js, ECharts): agrega una dependencia y, en general, estilos en línea o `canvas` sin texto accesible. Tres tipos de gráfico no la justifican.
- **Comparación con el período anterior:** el usuario eligió solo las cifras del período.
- **Fuente del sistema:** se pierde el aspecto pedido. El costo de incluir la fuente es de 49 KB, servidos por la propia aplicación.

## Consecuencias

- Cambia el aspecto de todas las pantallas sin tocar su lógica. El e2e con navegador real comprueba que no haya violaciones de CSP ni de Trusted Types, y que el dashboard dibuje sus indicadores y gráficos.
- Para actualizar la fuente hay que reemplazar los dos `woff2` y registrar los SHA-256 nuevos en este ADR.
- Un período de un año recorre como máximo 12 particiones de `message_events`, por el índice `(campaign_id, event_type, occurred_at)`.
