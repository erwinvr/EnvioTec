// Permissions declared by the quotas module (synced by database/seeds/system).
export const permissions = [
  { code: 'quotas.view', description: 'Ver cuotas de envío', administrative: false },
  { code: 'quotas.manage', description: 'Asignar y ajustar cuotas de envío', administrative: true },
];
