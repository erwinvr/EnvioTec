// Authentication stage of a session (ADR-018). Until a session reaches
// `full`, only the routes that declare its stage in config.stages answer;
// everything else responds 403 AUTH_STEP_REQUIRED.
//   mfa_verify       the user has MFA and has not entered a code yet
//   password_change  the password was set by an administrator (A5)
//   mfa_enroll       MFA is mandatory for this user and not configured yet
//   full             fully authenticated

export const STAGES = Object.freeze(['mfa_verify', 'password_change', 'mfa_enroll', 'full']);

export function computeStage({ mfaEnabled, mfaVerified, mustChangePassword, mfaRequired }) {
  if (mfaEnabled && !mfaVerified) return 'mfa_verify';
  if (mustChangePassword) return 'password_change';
  if (mfaRequired && !mfaEnabled) return 'mfa_enroll';
  return 'full';
}

// MFA is mandatory for administrators and for whoever submits or approves
// campaigns (Parte B), including AD accounts.
export function createMfaPolicy(catalog) {
  const codes = new Set(catalog
    .filter((permission) => permission.administrative)
    .map((permission) => permission.code));
  codes.add('campaigns.submit');
  codes.add('campaigns.approve');
  return {
    isRequired(permissions) {
      for (const code of permissions) if (codes.has(code)) return true;
      return false;
    },
  };
}
