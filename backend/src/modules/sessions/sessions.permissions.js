// Permissions declared by the sessions module (synced by database/seeds/system).
export const permissions = [
  { code: 'sessions.view_any', description: 'Ver las sesiones activas de cualquier usuario', administrative: false },
  { code: 'sessions.revoke_any', description: 'Cerrar sesiones de cualquier usuario', administrative: true },
];
