// Permissions declared by the audit-logs module (synced by database/seeds/system).
export const permissions = [
  { code: 'audit.view', description: 'Consultar la auditoría', administrative: false },
  { code: 'audit.export', description: 'Exportar la auditoría', administrative: false },
];
