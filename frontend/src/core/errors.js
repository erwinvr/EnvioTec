import { t } from './i18n.js';

// Central translation of API errors into what the user sees (A9). Never
// shows technical details; 5xx messages carry the requestId for support.
// Pure function: the caller decides how to display the result.
//   { kind: 'redirect', to }       session missing or a login step pending
//   { kind: 'reauth' }             the action needs a recent reauthentication
//   { kind: 'fields', fields, problems, message }   409/422 per-field errors;
//                                  `problems` lists them for actions without a form
//   { kind: 'message', message }   everything else
export function describeError(error) {
  const status = error?.status ?? 0;
  const code = error?.code;
  if (status === 401 && code !== 'INVALID_CREDENTIALS') return { kind: 'redirect', to: '/ingresar', message: t('errors.sessionExpired') };
  if (code === 'AUTH_STEP_REQUIRED') return { kind: 'step', stage: error.details?.[0]?.code };
  if (code === 'REAUTH_REQUIRED') return { kind: 'reauth' };
  if (code === 'INVALID_CREDENTIALS') return { kind: 'message', message: t('errors.invalidCredentials') };
  if (code === 'PRIVILEGE_ESCALATION') return { kind: 'message', message: t('errors.privilegeEscalation') };
  if (code === 'CSRF_REJECTED') return { kind: 'message', message: t('errors.csrf') };
  if (code === 'AREA_WRITE_DENIED') return { kind: 'message', message: t('errors.areaWriteDenied') };
  if (status === 403) return { kind: 'message', message: t('errors.forbidden') };
  if (status === 404) return { kind: 'message', message: t('errors.notFound') };
  if (status === 409 || status === 422) {
    const fields = {};
    const problems = [];
    for (const detail of error.details ?? []) {
      const text = t(`validation.${detail.code}`) === `validation.${detail.code}` ? t('validation.invalid') : t(`validation.${detail.code}`);
      // The missing template variable is named, so the user knows what to fix.
      const problem = typeof detail.variable === 'string' ? `${text}: ${detail.variable}` : text;
      fields[detail.field] = fields[detail.field] && fields[detail.field] !== problem ? `${fields[detail.field]}; ${problem}` : problem;
      if (!problems.includes(problem)) problems.push(problem);
    }
    return { kind: 'fields', fields, problems, message: error.message || t(status === 409 ? 'errors.conflict' : 'errors.validation') };
  }
  if (status === 429) {
    return { kind: 'message', message: error.retryAfter ? t('errors.rateLimitedFor', { seconds: error.retryAfter }) : t('errors.rateLimited') };
  }
  if (status === 0) return { kind: 'message', message: t('errors.network') };
  return { kind: 'message', message: t('errors.server', { requestId: error.requestId ?? '—' }) };
}
