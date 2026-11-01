// Route table. `permission` and `stages` only decide what the UI shows (A9);
// the backend checks every request. Pages are loaded on demand.
export const ROUTES = [
  { path: '/ingresar', public: true, guestOnly: true, load: () => import('./pages/auth/login.js') },
  { path: '/recuperar-contrasena', public: true, guestOnly: true, load: () => import('./pages/auth/forgot.js') },
  { path: '/restablecer-contrasena', public: true, load: () => import('./pages/auth/reset.js') },
  { path: '/mfa/verificar', stages: ['mfa_verify'], load: () => import('./pages/auth/mfa-verify.js') },
  { path: '/cambiar-contrasena', stages: ['password_change', 'full'], load: () => import('./pages/auth/password-change.js') },
  { path: '/mfa/configurar', stages: ['mfa_enroll', 'full'], load: () => import('./pages/auth/mfa-enroll.js') },
  { path: '/', load: () => import('./pages/home.js') },
  { path: '/mi-cuenta', load: () => import('./pages/account.js') },
  { path: '/usuarios', permission: 'users.view', load: () => import('./pages/admin/users-list.js') },
  { path: '/usuarios/nuevo', permission: 'users.create_local', load: () => import('./pages/admin/user-create.js') },
  { path: '/usuarios/revision', permission: 'users.view', load: () => import('./pages/admin/users-review.js') },
  { path: '/usuarios/:id', permission: 'users.view', load: () => import('./pages/admin/user-detail.js') },
  { path: '/roles', permission: 'roles.view', load: () => import('./pages/admin/roles.js') },
  { path: '/roles/:id', permission: 'roles.view', load: () => import('./pages/admin/role-detail.js') },
  { path: '/areas', permission: 'areas.manage', load: () => import('./pages/admin/areas.js') },
  { path: '/directorio', permission: 'directory.manage', load: () => import('./pages/admin/directory.js') },
  { path: '/parametros', permission: 'settings.manage', load: () => import('./pages/admin/settings.js') },
  { path: '/auditoria', permission: 'audit.view', load: () => import('./pages/admin/audit.js') },
];
