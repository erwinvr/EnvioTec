# Spike de Mandrill (fase 0.5)

Scripts de exploración para responder las preguntas de `docs/spikes/0.5-mandrill.md`. **No son código de producción**: no se importan desde `backend/` ni se reutilizan. Al cerrar la fase 0.5 quedan como referencia de cómo se obtuvieron los resultados.

## Requisitos

- Node.js 22 o superior (usa `fetch` nativo; sin dependencias).
- Un equipo con salida HTTPS a `mandrillapp.com`. El `fetch` de Node 22 no usa `HTTPS_PROXY`; si hay que salir por un proxy, ejecutar desde un equipo con salida directa.
- Una API key de Mandrill:
  - **Modo test:** para `01`, `02`, `03` y `04`. Los mensajes no se entregan, pero la API responde igual.
  - **Real, con el subdominio de envío verificado:** para comprobar entrega, adjunto, aperturas, clics, baja y rebotes.

## Seguridad de los datos

- La API key se pasa solo como variable de entorno en la línea de comandos. Nunca en archivos ni en Git.
- Los resultados se guardan en `out/` (ignorado por Git, permisos 600). Contienen las direcciones de los buzones de prueba: quitarlas antes de copiar algo a `docs/`.
- `02-send-batch.mjs` envía correos reales con una key real. Exige `SPIKE_CONFIRM_SEND=si` y acepta como máximo 5 destinatarios.

## Orden de ejecución

```bash
cd spikes/mandrill

# 1. Verificar la key, la reputación, la cuota por hora y el estado DKIM/SPF del dominio
MANDRILL_API_KEY=... node 01-ping.mjs

# 2. Enviar un lote (por defecto con merge_language mailchimp)
MANDRILL_API_KEY=... \
SPIKE_CONFIRM_SEND=si \
SPIKE_FROM_EMAIL=spike@envios.empresa.com \
SPIKE_TO=buzon1@empresa.com,buzon2@gmail.com,buzon3@outlook.com \
SPIKE_PDF=/ruta/a/prueba.pdf \
node 02-send-batch.mjs

# Repetir con SPIKE_MERGE_LANGUAGE=handlebars para comparar el escape.

# 3. Buscar los mensajes por metadata (usar el campaignId que imprime el paso 2)
MANDRILL_API_KEY=... SPIKE_CAMPAIGN_ID=... node 03-search.mjs

# 4. Consultar estado, eventos y contenido renderizado de cada mensaje
MANDRILL_API_KEY=... node 04-info.mjs out/<archivo>-send-batch.json

# 5. Revisar la lista de rechazos (después de darse de baja o de un rebote)
MANDRILL_API_KEY=... node 05-rejects.mjs
MANDRILL_API_KEY=... SPIKE_EMAIL=buzon2@gmail.com node 05-rejects.mjs
```

Para probar un rebote duro, incluir en `SPIKE_TO` una dirección inexistente de un dominio propio.

## Revisión manual en los buzones

1. **Adjunto:** el PDF llega completo a cada destinatario y abre bien.
2. **Escape:** las líneas "HTML", "Atributo" y "Entidad" deben mostrar el texto literal (`<b>negrita</b>`, etc.), no negrita ni una imagen rota. Revisar también el código fuente del mensaje.
3. **Headers:** en "Mostrar original" (Gmail) o "Ver origen" (Outlook), buscar `List-Unsubscribe` y `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Anotar si aparecen y a qué URL apuntan.
4. **Baja:** hacer clic en "Darse de baja" en un buzón y luego ejecutar `05-rejects.mjs`.
5. **Aperturas y clics:** abrir el correo con imágenes y hacer clic en el enlace; luego ejecutar `04-info.mjs`.

## Supuestos a confirmar

Estos puntos salen de la documentación conocida de Mandrill y pueden no ser exactos; el spike sirve justamente para confirmarlos:

- La búsqueda por metadata usa la sintaxis `u_<campo>:<valor>` y puede requerir que el campo esté indexado en la configuración de la cuenta (Settings → Sending Defaults → Custom Metadata). Si `03-search.mjs` no encuentra nada, revisar esa configuración o probar otra consulta con `SPIKE_QUERY`.
- `messages/content` devuelve el contenido renderizado solo de mensajes recientes y puede no estar disponible en modo test.
- La sintaxis del enlace de baja es `*|UNSUB:url|*` (mailchimp) y `{{unsub "url"}}` (handlebars).
- La retención de 30 días no se puede medir en un spike corto; se confirma con la documentación oficial o con soporte de Mailchimp.
