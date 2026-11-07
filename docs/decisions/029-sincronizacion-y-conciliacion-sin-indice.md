# ADR-029: Sincronización y conciliación sin depender del índice de metadata, y detalle de aperturas

- **Estado:** Aceptado (pedido por el usuario el 2026-11-07)
- **Fecha:** 2026-11-07

## Contexto

En las primeras pruebas reales con Mailchimp Transactional (spike 0.5) apareció lo siguiente:

- `messages/search` por metadata (`u_campaign_id:…`) solo encuentra mensajes cuando el campo está indexado en la cuenta (*Settings → Custom Metadata*), y solo para los mensajes enviados después de indexarlo. Sin el índice, la sincronización no traía ningún evento (R1).
- La conciliación de un lote incierto buscaba por `u_batch_id`. Sin el índice, o antes de que Mailchimp indexara el mensaje, habría concluido que el lote no salió y lo habría reenviado (R3).
- Los datos de la API se actualizan con varios minutos de retraso respecto del panel de Mailchimp.
- Por cada apertura y cada clic, la API devuelve hora, IP, ubicación y user agent. Gmail descarga el píxel con su proxy de imágenes (IP de Google, sin user agent) al recibir el correo, y luego sirve la imagen desde su caché.

## Decisión

- **Sincronización:**
  - primero busca por `campaign_id` indexado;
  - si encuentra menos mensajes que los aceptados, lee los que faltan con `messages/info`, por el ID que EnvioTec guarda de cada destinatario;
  - el tope es de 100 consultas por ciclo, empezando por los destinatarios sin ningún evento.
- **Conciliación de un lote incierto:**
  - busca cada destinatario por su correo (`email:…`, que no depende del índice) y lo da por enviado solo si el `batch_id` de la metadata coincide;
  - solo concilia lotes inciertos hace más de **60 minutos**, para que el retraso del índice no se confunda con un envío que no ocurrió;
  - si una dirección no se puede buscar, el lote queda incierto para revisión manual y nunca se reenvía a ciegas.
- **Detalle de aperturas y clics:**
  - se guardan la IP, la ubicación y el user agent, más el dispositivo, el sistema y el programa deducidos del user agent;
  - los proxys de imágenes (Gmail, Yahoo) se identifican como "Proxy";
  - los eventos guardados antes de este cambio se completan cuando la sincronización los vuelve a ver.
- **Privacidad:** la IP, la ubicación y el user agent son datos personales del destinatario. Solo los ve quien tiene `contacts.view`; el resto ve la hora, el dispositivo, el sistema y el programa. No van en la exportación CSV.
- **Configuración recomendada de la cuenta:** indexar `campaign_id` y `batch_id` en *Custom Metadata* (runbook, sección 10). El índice permite sincronizar campañas grandes; las consultas por ID quedan como respaldo.

## Consecuencias

- Una campaña grande sin índice tarda varios ciclos en completar sus eventos.
- Un lote incierto espera al menos una hora antes de reintentarse.
- Una apertura registrada en Gmail suele ser del proxy al recibir el correo, no una lectura confirmada. El reporte lo indica con el dispositivo "Proxy".
