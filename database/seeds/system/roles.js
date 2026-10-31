// Initial roles (docs/architecture.md, section 4.2). The seed creates them if
// missing and never overwrites the permissions of an existing non-system role,
// because administrators may have changed them. `superadmin` always receives
// every permission of the catalog.

export const ROLES = [
  {
    name: 'superadmin',
    description: 'Rol del sistema con todos los permisos. No se edita ni se borra.',
    isSystem: true,
    permissions: 'all',
  },
  {
    name: 'administrador',
    description: 'Administración de usuarios, roles, áreas, parámetros, cuotas y supresión; lectura de negocio.',
    permissions: [
      'users.view', 'users.update', 'users.disable', 'users.reset_password', 'users.reset_mfa', 'users.unlock',
      'users.create_local', 'users.renew_local',
      'roles.view', 'roles.create', 'roles.update', 'roles.delete', 'roles.assign',
      'permissions.view', 'sessions.view_any', 'sessions.revoke_any', 'audit.view', 'audit.export',
      'settings.manage', 'areas.view_all', 'areas.manage', 'directory.manage', 'senders.manage',
      'quotas.view', 'quotas.manage', 'suppressions.view', 'suppressions.manage',
      'templates.view', 'contacts.view', 'campaigns.view', 'reports.view',
    ],
  },
  {
    name: 'operador',
    description: 'Operador de campañas: plantillas, contactos y campañas de su área.',
    permissions: [
      'templates.view', 'templates.create', 'templates.update', 'templates.delete',
      'contacts.view', 'contacts.create', 'contacts.update', 'contacts.import', 'contacts.delete',
      'suppressions.view',
      'campaigns.view', 'campaigns.create', 'campaigns.update', 'campaigns.delete', 'campaigns.submit',
      'campaigns.cancel', 'campaigns.pause', 'campaigns.send_test',
      'quotas.view', 'reports.view',
    ],
  },
  {
    name: 'aprobador',
    description: 'Aprobador de campañas de su área.',
    permissions: [
      'campaigns.view', 'campaigns.approve', 'campaigns.cancel', 'campaigns.pause',
      'templates.view', 'contacts.view', 'reports.view',
    ],
  },
  {
    name: 'auditoria',
    description: 'Consulta de auditoría, usuarios, roles y sesiones de todas las áreas.',
    permissions: [
      'audit.view', 'audit.export', 'users.view', 'roles.view', 'permissions.view', 'sessions.view_any',
      'areas.view_all', 'reports.view', 'campaigns.view', 'quotas.view',
    ],
  },
  {
    name: 'reportes',
    description: 'Reportes de todas las áreas.',
    permissions: ['reports.view', 'reports.export', 'campaigns.view', 'areas.view_all'],
  },
];
