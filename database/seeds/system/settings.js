// System parameters with their default value and valid range (Parte B). The
// seed inserts missing keys and refreshes type, range and description, but
// never overwrites a value that an administrator already changed.

export const SETTINGS = [
  { key: 'local_account.default_validity_days', type: 'integer', value: 90, min: 1, max: 365,
    description: 'Vigencia propuesta al crear una cuenta local (días)' },
  { key: 'local_account.max_validity_days', type: 'integer', value: 180, min: 1, max: 365,
    description: 'Vigencia máxima permitida para una cuenta local (días)' },
  { key: 'local_account.renewal_max_days', type: 'integer', value: 90, min: 1, max: 365,
    description: 'Extensión máxima por cada renovación de una cuenta local (días)' },
  { key: 'local_account.expiry_warning_days', type: 'integer', value: 7, min: 1, max: 30,
    description: 'Anticipación del aviso de vencimiento de una cuenta local (días)' },
  { key: 'local_account.inactivity_disable_days', type: 'integer', value: 45, min: 1, max: 365,
    description: 'Desactivación de una cuenta local por falta de uso (días)' },
  { key: 'sending.monthly_global_cap', type: 'integer', value: 100000, min: 1, max: 10000000,
    description: 'Tope global de envíos por mes calendario (America/La_Paz)' },
  { key: 'test_send.daily_max_per_user', type: 'integer', value: 5, min: 0, max: 50,
    description: 'Máximo de envíos de prueba por usuario por día' },
  { key: 'test_send.allowed_domains', type: 'string_list', value: [],
    description: 'Dominios internos permitidos como destino de envíos de prueba' },
  { key: 'mfa.enrollment_code_validity_hours', type: 'integer', value: 24, min: 1, max: 72,
    description: 'Vigencia del código de enrolamiento de MFA (horas)' },
  { key: 'notifications.admin_emails', type: 'email_list', value: [],
    description: 'Destinatarios de avisos de vencimiento de cuentas y de uso de la cuenta de emergencia' },
];
