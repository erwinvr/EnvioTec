// Permissions declared by the administration module (synced by database/seeds/system).
export const permissions = [
  { code: 'settings.manage', description: 'Modificar los parámetros del sistema', administrative: true },
  { code: 'areas.view_all', description: 'Ver datos de negocio de todas las áreas', administrative: false },
  { code: 'areas.manage', description: 'Crear y modificar áreas', administrative: true },
  { code: 'directory.manage', description: 'Configurar la equivalencia de grupos de AD con roles', administrative: true },
];
