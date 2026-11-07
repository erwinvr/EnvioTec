# ADR-027: El PDF de la campaña es opcional

- **Estado:** Aceptado (pedido por el usuario el 2026-11-07)
- **Fecha:** 2026-11-07

## Contexto

La Parte B definía la campaña como "plantilla + lista + PDF + remitente" y exigía un PDF por campaña. El negocio necesita también campañas solo con el cuerpo del correo.

## Decisión

- Una campaña lleva **como máximo un PDF**, el mismo para todos los destinatarios, y puede no llevar ninguno.
- **Si lleva PDF, se mantienen todos los controles:**
  - antivirus (ClamAV);
  - firma `%PDF-` y máximo 5 MB;
  - normalización con qpdf y rechazo de PDFs cifrados o con contenido activo;
  - se guarda su SHA-256.
- **Si el PDF subido no está listo o fue rechazado,** la campaña no se envía a aprobación ni a prueba (`attachment_not_ready`). Nunca sale sin el PDF que el usuario subió sin que él lo haya decidido.
- **Quitar el PDF:** `DELETE /api/v1/campaigns/:id/attachment` (`campaigns.update`), solo en borrador.
  - Se audita como `campaign.attachment_remove`.
  - El registro del adjunto y su archivo se conservan, por la retención perpetua de la Parte B.
- **El worker envía sin `attachments`** cuando la campaña no tiene PDF.

## Consecuencias

- Las campañas sin PDF son más livianas, lo que facilita los lotes (R2).
- La Parte B (`docs/project-spec.md`) quedó actualizada.
