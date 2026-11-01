# ADR-023: Campañas — decisiones de implementación

- **Estado:** Propuesto (decidido con la autorización general del 2026-10-31)
- **Fecha:** 2026-11-01

## Contexto

La iteración 8.4 implementa el flujo de campañas del ADR-011. Aparecieron decisiones que la Parte B no fija.

## Decisión

- **Área de la campaña:** es la de su lista, que tiene que estar en el alcance de quien la crea. La plantilla y el remitente tienen que ser de esa misma área. Así, un administrador con `areas.view_all` crea la campaña en el área correcta sin elegirla a mano.
- **Estados:** `draft → submitted → approved | scheduled → sending ⇄ paused → completed`; `cancelled` desde cualquier estado anterior a `completed`. Quien aprueba también puede rechazar, con motivo, y la campaña vuelve a borrador.
- **Maker-checker en dos capas:** el servicio rechaza que quien envió a aprobación apruebe, y un CHECK de la base (`approved_by <> submitted_by`) lo impide incluso con acceso directo.
- **Aprobación:** exige re-autenticación. En una sola transacción:
  - foto de destinatarios sin suprimidos ni anonimizados;
  - reserva de la cuota del creador con bloqueo de fila: si no alcanza, no se aprueba y no queda foto;
  - comprobación de que la cuenta del creador esté activa y vigente (ADR-011).
- **Edición después de aprobar:** la campaña vuelve a borrador, se borra la foto y se libera la reserva.
- **Envíos de prueba:** al propio correo o a un dominio de `test_send.allowed_domains`, con el límite diario controlado bajo un advisory lock por usuario. Descuentan 1 del saldo y del tope global en el momento y se encolan en `send`. La 8.5 los entrega.
- **`campaign_recipients` sin particionar:** el ADR-010 lo preveía particionado, pero con 100.000 envíos al mes son alrededor de 1,2 millones de filas al año, que un índice por `(campaign_id, status)` cubre bien. Lo que sí se particiona son los eventos de seguimiento (8.5), que son varios por destinatario.
- **PDF:** el `file-processor` usa una imagen propia (`file-processor`): el runtime más `qpdf`. Se envía el archivo original; la copia normalizada solo sirve para inspeccionarlo.

## Consecuencias

- Una campaña en borrador con envíos de prueba no se puede borrar (FK RESTRICT desde los movimientos de cuota y las pruebas): se cancela.
- Hay una imagen más que Trivy escanea en `npm run check`.
