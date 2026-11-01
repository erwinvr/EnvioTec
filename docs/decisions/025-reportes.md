# ADR-025: Reportes — decisiones de implementación

- **Estado:** Propuesto (decidido con la autorización general del 2026-10-31)
- **Fecha:** 2026-11-01

## Contexto

La iteración 8.6 implementa los reportes de la Parte B: entregas, aperturas aproximadas, clics, rebotes, quejas y bajas, por campaña y por contacto, con exportación. Los datos salen del estado de envío de cada destinatario (`campaign_recipients`) y de los eventos sincronizados desde Mandrill (`message_events`, ADR-024).

## Decisión

- **Definiciones**, por destinatario y no por evento:
  - *Aceptado*: Mandrill recibió el mensaje (`status = sent`).
  - *Entregado*: tiene el evento `sent` y no tiene rebote duro ni rechazo posterior.
  - *Abierto* o *con clics*: al menos una apertura o un clic. Las tasas se calculan sobre los entregados.
  - *Rebotes, quejas y bajas*: destinatarios con al menos uno de esos eventos.
- **Las aperturas son aproximadas:** la UI lo dice en cada pantalla de reportes, porque el píxel se bloquea o se precarga.
- **Cálculo al leer:** las cifras se calculan en cada consulta con agregados sobre los índices por campaña y por destinatario. Con 100.000 envíos al mes alcanza. Si hiciera falta, se materializa en la Fase 9 sin cambiar la API.
- **Alcance:**
  - Cada consulta filtra por área en el repository.
  - Una campaña de otra área responde 404, también en destinatarios y exportación.
  - Con `areas.view_all` (perfiles de auditoría, reportes y administración) se ven todas las áreas.
  - Solo aparecen las campañas que empezaron a enviarse.
- **Datos personales:**
  - Sin `contacts.view`, los correos se enmascaran en pantalla **y en la exportación**.
  - La exportación lleva solo el correo, el estado y las cifras, sin nombres ni atributos (minimización).
  - Los destinatarios anonimizados aparecen con su seudónimo.
- **Reporte por contacto:**
  - La búsqueda es un `POST` con la dirección en el body, para que nunca quede en la URL, los logs de acceso del proxy ni el historial del navegador.
  - Cada búsqueda se audita (`reports.contact_lookup`) con el hash SHA-256 de la dirección como recurso, nunca con la dirección en claro.
- **Exportación:** CSV con fórmulas neutralizadas (`csvCell`), en streaming por páginas de 1000 destinatarios. Se audita antes de enviarse (`reports.export`), indicando si salió enmascarada.
- **Filtros:** estado y evento solo admiten valores de una allowlist, cada uno asociado a un fragmento SQL fijo (A8).
- **Índice nuevo:** `campaign_recipients (email)`, para el reporte por contacto.

## Alternativas descartadas

- **Tabla de totales mantenida por la sincronización:** agrega estado que conciliar sin una necesidad medida.
- **Búsqueda por contacto con `GET ?email=`:** dejaría la dirección en los logs.
- **Exportar sin enmascarar a quien tiene `reports.export`:** la Parte B pide enmascarar para quien no tiene `contacts.view`, y la exportación es la vía de mayor alcance.

## Consecuencias

- Las cifras dependen de que la sincronización esté al día (cada 10 minutos). Lo que Mandrill no conservó (más de 30 días sin sincronizar) no aparece.
- Las cifras de campañas muy grandes se calculan en cada consulta. Se revisa en la Fase 9.
