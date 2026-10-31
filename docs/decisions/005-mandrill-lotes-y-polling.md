# ADR-005: Mandrill — envío por lotes y estado por polling

- **Estado:** Aceptado (sujeto a confirmación en el spike de la fase 0.5)
- **Fecha:** 2026-10-31

## Contexto

El envío es por Mailchimp Transactional (Mandrill), con un plan de 100.000 envíos al mes. La app es solo interna: no hay webhooks entrantes y el estado se obtiene por polling. Según el negocio, Mandrill conserva la información de los mensajes 30 días. Cada correo lleva un PDF de hasta 5 MB (unos 6,7 MB en base64): una llamada por destinatario implicaría unos 670 GB al mes de subida. La API no ofrece, hasta donde se sabe, una clave de idempotencia.

## Decisión

- Cliente propio con `fetch` nativo (sin SDK): timeout, validación por schema de cada respuesta y dos API keys separadas (campañas y correos del sistema), inyectadas como Docker secrets.
- Envío por lotes con `preserve_recipients: false` y `merge_vars` por destinatario, para subir el PDF una vez por lote. Metadata por destinatario (`campaign_id`, `recipient_id`) para cruzar eventos.
- Cada lote pasa por `pending` → `in_flight` → `accepted`. Un timeout o error de red después del envío marca el lote como `ambiguous`: antes de reintentar se concilia buscando por metadata, para no enviar dos veces.
- Polling periódico, con frecuencia muy por debajo de los 30 días de retención. Los eventos se guardan con una clave de idempotencia derivada (mensaje, tipo, timestamp, URL) si Mandrill no da un ID propio.
- Bajas, rebotes duros y quejas se copian a la supresión local global.

## A verificar en el spike (fase 0.5)

1. Retención real y límites de `messages/info`, `messages/search` y de la lista de rechazos.
2. Que el envío por lotes devuelva un `_id` por destinatario.
3. Cómo conciliar un lote ambiguo (búsqueda por metadata).
4. Que el enlace de baja de Mandrill cumpla la baja con un clic (RFC 8058) que exigen Gmail y Yahoo.
5. Escape de variables (ADR-013).

## Alternativas descartadas

- **Webhooks:** requieren exponer un endpoint a internet, contra la Parte B.
- **Una llamada por destinatario:** ancho de banda inviable.
- **SDK oficial:** agrega dependencias transitivas para una API HTTP simple.

## Consecuencias

- Los eventos que ocurran después de 30 días (aperturas o clics tardíos) no se registran: riesgo aceptado (ADR-014).
- Si el spike muestra que el polling no alcanza, esta decisión se revisa con un nuevo ADR.
