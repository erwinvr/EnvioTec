# ADR-011: Foto de destinatarios, cuotas y tope global

- **Estado:** Aceptado
- **Fecha:** 2026-10-31

## Contexto

La cuota es un saldo de envíos por usuario, sin período: en cuentas locales se usa durante la vigencia y se mantiene al renovar; en cuentas de AD no vence y solo cambia por ajuste de un administrador. Cada destinatario y cada envío de prueba descuenta 1. El plan es de 100.000 envíos al mes y la suma de saldos puede superarlo. La lista de contactos puede cambiar entre la aprobación y el envío.

## Decisión

- Al aprobar, en una transacción: se genera `campaign_recipients` (foto de la lista con supresión aplicada) y se reserva el número de destinatarios en el saldo del creador con `SELECT … FOR UPDATE`. Saldo insuficiente → no se aprueba.
- Al enviar cada lote: se vuelve a aplicar la supresión (solo puede reducir destinatarios), se controla el tope global en `monthly_send_usage` con bloqueo de fila y cada destinatario aceptado pasa de reservado a consumido. Si se alcanza el tope global, la campaña se pausa y se avisa a `notifications.admin_emails`.
- Editar una campaña aprobada o programada sin envíos iniciados la devuelve a borrador y libera toda la reserva. Cancelar libera la reserva no consumida. Una campaña enviando o en pausa no se edita.
- Envío de prueba: consume 1 del saldo y del tope global en el momento; máximo 5 por usuario por día; solo al propio correo o a dominios internos permitidos.
- CHECK `reserved + consumed <= assigned`; cada movimiento queda en `quota_movements` (append-only) y en la auditoría. Nadie modifica su propio saldo.
- Una cuenta local vencida no puede usar su saldo hasta que se renueve.

## Alternativas descartadas

- **Calcular destinatarios al enviar:** la cuota reservada dejaría de coincidir con lo enviado.
- **Cuota mensual por usuario:** descartada por el negocio.

## Consecuencias

- La foto de destinatarios crece con cada campaña (tabla particionada, ADR-010).
