// Permissions declared by the campaigns module (synced by database/seeds/system).
export const permissions = [
  { code: 'campaigns.view', description: 'Ver campañas', administrative: false },
  { code: 'campaigns.create', description: 'Crear campañas', administrative: false },
  { code: 'campaigns.update', description: 'Modificar campañas', administrative: false },
  { code: 'campaigns.delete', description: 'Eliminar campañas en borrador', administrative: false },
  { code: 'campaigns.submit', description: 'Enviar campañas a aprobación', administrative: false },
  { code: 'campaigns.approve', description: 'Aprobar campañas', administrative: false },
  { code: 'campaigns.cancel', description: 'Cancelar campañas', administrative: false },
  { code: 'campaigns.pause', description: 'Pausar y reanudar campañas', administrative: false },
  { code: 'campaigns.send_test', description: 'Enviar correos de prueba', administrative: false },
];
