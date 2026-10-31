// Permissions declared by the roles module (synced by database/seeds/system).
export const permissions = [
  { code: 'roles.view', description: 'Ver roles', administrative: false },
  { code: 'roles.create', description: 'Crear roles', administrative: true },
  { code: 'roles.update', description: 'Modificar roles y sus permisos', administrative: true },
  { code: 'roles.delete', description: 'Eliminar roles', administrative: true },
  { code: 'roles.assign', description: 'Asignar y retirar roles a usuarios', administrative: true },
];
