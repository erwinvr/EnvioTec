# ADR-024: Envío y sincronización con Mandrill — decisiones de implementación

- **Estado:** Propuesto (decidido con la autorización general del 2026-10-31; sujeto al spike 0.5)
- **Fecha:** 2026-11-01

## Contexto

La iteración 8.5 implementa el envío de campañas y la sincronización de eventos descritos en los ADR-005 y ADR-013. Todavía no hay una API key de campañas válida, así que todo se construye contra un doble de Mandrill en proceso (`tests/helpers/mandrill-mock.js`). Lo que depende del comportamiento real del proveedor queda marcado para el spike.

## Decisión

- **Sin key no se envía:** sin `MANDRILL_CAMPAIGNS_API_KEY`, el worker no programa ni el envío ni la sincronización y registra una advertencia. Los envíos de prueba terminan en `failed` con el motivo `sending_not_configured`. La key de campañas está separada de la de correos del sistema y solo la recibe el worker, como Docker secret.
- **Lotes:** al llegar la hora, la campaña pasa a `sending` y sus destinatarios se agrupan en `send_batches` de `SENDING_BATCH_SIZE`, 100 por defecto. Cada lote es una sola llamada a `messages/send`:
  - el mismo PDF;
  - `preserve_recipients: false`, para que ningún destinatario vea a los demás;
  - `merge_vars` por destinatario;
  - `metadata` con `campaign_id` y `batch_id`, y `recipient_metadata` con `recipient_id`, para cruzar eventos.
- **Escape de variables (ADR-013):**
  - EnvioTec escapa cada valor para HTML una sola vez y lo inserta con triple llave (`{{{var}}}`), para que Mandrill no lo escape de nuevo ni lo interprete.
  - El texto plano usa una variante `var__text` sin escapar.
  - En ambas se eliminan los caracteres de control.
  - Ningún valor se evalúa como plantilla.
  - *A confirmar en el spike (R6):* que Handlebars de Mandrill no procese el contenido de un `merge_var`.
- **Supresión en cada lote:** se aplica de nuevo antes de enviar, porque alguien pudo darse de baja después de la aprobación. Un suprimido nunca se envía.
- **Contabilidad de la cuota:**
  - Al tomar un lote se consume la cuota de quien creó la campaña, desde lo reservado, y se descuenta del tope global; las dos cosas con bloqueo de fila.
  - Lo que Mandrill no acepta (rechazado, inválido o ausente de la respuesta) se devuelve como movimiento `refund`, al saldo reservado y al mes.
  - Al terminar la campaña se libera lo que quedó reservado.
  - El saldo cuenta solo lo realmente entregado al proveedor.
- **Errores:**
  - Si Mandrill responde con un error, no se envió nada: el lote vuelve a pendiente con la cuota devuelta y se reintenta. Después de 5 intentos queda `failed`.
  - Un timeout o un corte después de enviar deja el lote `ambiguous`. Nunca se reintenta a ciegas: pasados 2 minutos, la conciliación busca el lote en Mandrill por `u_batch_id` y marca como enviados los mensajes que encuentra. El resto se devuelve y se reintenta (R3).
  - Toda respuesta de Mandrill se valida contra un schema antes de usarse (A8, entrada no confiable). Una respuesta inesperada se trata como resultado incierto.
- **Tope global:** si al tomar un lote se alcanza el tope del mes, la campaña pasa a `paused`, se audita y se avisa por correo a `notifications.admin_emails`. Se reanuda manualmente (8.4).
- **Cancelación:** los lotes pendientes de una campaña cancelada no se envían y sus destinatarios quedan `cancelled`.
- **Envíos de prueba:**
  - cada variable se muestra como `[nombre]`;
  - el asunto lleva el prefijo `[PRUEBA]`;
  - el PDF y las imágenes son los reales;
  - la cuota ya se descontó al pedirlo (8.4).
- **Sincronización por polling (ADR-005):**
  - Cada 10 minutos, por cada campaña iniciada en los últimos 30 días, `messages/search` con `u_campaign_id`.
  - Si la respuesta llega al límite de 1000 resultados, se consulta lote por lote (`u_batch_id`, como máximo 100 mensajes cada uno).
  - De cada mensaje se guardan su estado, las aperturas y los clics en `message_events`, particionada por mes, con una clave idempotente: SHA-256 de mensaje, tipo, timestamp y URL.
  - Los rebotes duros, las quejas y las bajas pasan a la supresión global, igual que la lista `rejects/list` de Mandrill.
  - Se ignoran los eventos de más de 40 días, que no pueden caer en una partición inexistente.
  - *A confirmar en el spike (R1):* límites de frecuencia de `messages/search` y la retención real.
- **Programación:**
  - el `dispatch` (iniciar, encolar lotes, cerrar campañas, conciliar) corre cada 30 segundos en el programador de trabajos del worker (ADR-020), una sola instancia a la vez;
  - cada lote es un trabajo de la cola `send`.
- **Pruebas:** contra un servidor HTTP en proceso que imita las respuestas de Mandrill, con la base real. La URL de la API solo admite `http:` hacia loopback y fuera de producción.

## Alternativas descartadas

- **Un mensaje por llamada:** 100.000 llamadas al mes y el PDF subido una vez por destinatario (R2).
- **Webhooks:** la Parte B prohíbe endpoints expuestos.
- **Reintentar un lote con timeout sin conciliar:** produciría envíos duplicados.
- **Consumir toda la cuota al iniciar la campaña:** los rechazos del proveedor quedarían cobrados.

## Consecuencias

- Hay estados nuevos en lotes y destinatarios. Los reportes (8.6) leen `campaign_recipients` y `message_events`.
- El comportamiento real del proveedor (R1, R2, R3, R4, R6) se valida en el spike 0.5, con la API key y el buzón de prueba. Hasta entonces, ningún correo real sale de EnvioTec.
