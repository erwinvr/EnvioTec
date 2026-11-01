import { MAX_LENGTH as PASSWORD_MAX_LENGTH } from '../../core/auth/password-policy.js';
import { successSchema } from '../../core/http/response.js';

const username = { type: 'string', pattern: '^[A-Za-z0-9._-]{3,64}$' };
// Login and reauthentication accept any length up to 256 so old passwords
// still work; new passwords follow the policy (12 to 128).
const anyPassword = { type: 'string', minLength: 1, maxLength: 256 };
const newPassword = { type: 'string', minLength: 1, maxLength: PASSWORD_MAX_LENGTH * 2 };
const totpCode = { type: 'string', pattern: '^[0-9]{6}$' };
const recoveryCode = { type: 'string', pattern: '^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$' };
const enrollmentCode = { type: 'string', pattern: '^[A-Za-z2-7]{4}(-?[A-Za-z2-7]{4}){3}$' };

const body = (properties, required = Object.keys(properties), extra = {}) => ({
  type: 'object', additionalProperties: false, required, properties, ...extra,
});

export const loginBody = body({ username, password: anyPassword });
export const mfaVerifyBody = body({ code: totpCode, recoveryCode }, [], {
  oneOf: [{ required: ['code'] }, { required: ['recoveryCode'] }],
});
export const enrollStartBody = body({ enrollmentCode }, []);
export const enrollConfirmBody = body({ code: totpCode });
export const passwordChangeBody = body({ currentPassword: anyPassword, newPassword });
export const reauthBody = body({ password: anyPassword, code: totpCode }, [], {
  oneOf: [{ required: ['password'] }, { required: ['code'] }],
});
export const forgotBody = body({ email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' } });
export const resetBody = body({ token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, newPassword });
export const sessionIdParams = body({ id: { type: 'string', pattern: '^[0-9a-f]{64}$' } });
export const userIdParams = body({ id: { type: 'string', format: 'uuid' } });

const nullableString = { type: ['string', 'null'] };

const sessionState = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'csrfToken', 'sessionExpiresAt', 'mfaRequired', 'user', 'permissions'],
  properties: {
    stage: { type: 'string', enum: ['mfa_verify', 'password_change', 'mfa_enroll', 'full'] },
    csrfToken: { type: 'string' },
    sessionExpiresAt: { type: 'string' },
    mfaRequired: { type: 'boolean' },
    user: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'username', 'email', 'displayName', 'authSource', 'areaId', 'mfaEnabled'],
      properties: {
        id: { type: 'string' },
        username: { type: 'string' },
        email: { type: 'string' },
        displayName: { type: 'string' },
        authSource: { type: 'string', enum: ['local', 'ad'] },
        areaId: nullableString,
        mfaEnabled: { type: 'boolean' },
      },
    },
    permissions: { type: 'array', items: { type: 'string' } },
  },
};

const empty = { type: 'object', additionalProperties: false, properties: {} };

export const sessionStateResponse = successSchema(sessionState);
export const emptyResponse = successSchema(empty);

export const enrollStartResponse = successSchema({
  type: 'object',
  additionalProperties: false,
  required: ['secret', 'otpauthUri'],
  properties: { secret: { type: 'string' }, otpauthUri: { type: 'string' } },
});

export const enrollConfirmResponse = successSchema({
  type: 'object',
  additionalProperties: false,
  required: ['recoveryCodes', 'session'],
  properties: {
    recoveryCodes: { type: 'array', items: { type: 'string' } },
    session: sessionState,
  },
});

export const sessionsResponse = successSchema({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'createdAt', 'lastSeenAt', 'expiresAt', 'ip', 'userAgent', 'current'],
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'string' },
      lastSeenAt: { type: 'string' },
      expiresAt: { type: 'string' },
      ip: nullableString,
      userAgent: nullableString,
      current: { type: 'boolean' },
    },
  },
});

export const mfaResetResponse = successSchema({
  type: 'object',
  additionalProperties: false,
  required: ['enrollmentCode', 'expiresAt'],
  properties: { enrollmentCode: nullableString, expiresAt: nullableString },
});
