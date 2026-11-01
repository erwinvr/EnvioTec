import { api, ApiError, setCsrfToken } from './api.js';

// Current session as the backend describes it (GET /auth/me). Permissions
// here only show or hide UI; the backend enforces them on every request (A6).

let state = null;

export function setSession(session) {
  state = session ? { ...session, permissions: new Set(session.permissions) } : null;
  setCsrfToken(session?.csrfToken ?? null);
}

export async function loadSession() {
  try {
    const { data } = await api.get('/api/v1/auth/me');
    setSession(data);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    setSession(null);
  }
  return state;
}

export const auth = {
  currentUser: () => state?.user ?? null,
  stage: () => state?.stage ?? null,
  isSignedIn: () => state !== null,
  mfaRequired: () => state?.mfaRequired === true,
  sessionExpiresAt: () => state?.sessionExpiresAt ?? null,
  hasPermission: (code) => state?.permissions.has(code) === true,
  hasAnyPermission: (codes) => codes.some((code) => state?.permissions.has(code) === true),
};

export async function logout() {
  try {
    await api.post('/api/v1/auth/logout');
  } finally {
    setSession(null);
  }
}
