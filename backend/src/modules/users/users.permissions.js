// Permissions declared by the users module (synced by database/seeds/system).
export const permissions = [
  { code: 'users.view', description: 'Ver usuarios', administrative: false },
  { code: 'users.update', description: 'Modificar datos de usuarios', administrative: true },
  { code: 'users.disable', description: 'Desactivar y reactivar usuarios', administrative: true },
  { code: 'users.reset_password', description: 'Restablecer la contraseña de usuarios locales', administrative: true },
  { code: 'users.reset_mfa', description: 'Emitir códigos de enrolamiento de MFA y reiniciar el MFA de usuarios', administrative: true },
  { code: 'users.unlock', description: 'Desbloquear cuentas bloqueadas', administrative: true },
  { code: 'users.create_local', description: 'Crear usuarios locales', administrative: true },
  { code: 'users.renew_local', description: 'Renovar la vigencia de usuarios locales', administrative: true },
];
