// Permissions declared by the contacts module (synced by database/seeds/system).
export const permissions = [
  { code: 'contacts.view', description: 'Ver contactos', administrative: false },
  { code: 'contacts.create', description: 'Crear contactos', administrative: false },
  { code: 'contacts.update', description: 'Modificar contactos', administrative: false },
  { code: 'contacts.import', description: 'Importar contactos desde CSV', administrative: false },
  { code: 'contacts.export', description: 'Exportar contactos', administrative: false },
  { code: 'contacts.delete', description: 'Eliminar o anonimizar contactos', administrative: false },
  { code: 'suppressions.view', description: 'Ver la lista de supresión', administrative: false },
  { code: 'suppressions.manage', description: 'Agregar entradas a la lista de supresión', administrative: true },
];
