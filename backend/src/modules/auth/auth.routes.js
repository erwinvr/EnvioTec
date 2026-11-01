import { createAuthController } from './auth.controller.js';
import {
  emptyResponse, enrollConfirmBody, enrollConfirmResponse, enrollStartBody, enrollStartResponse, forgotBody,
  loginBody, mfaVerifyBody, passwordChangeBody, reauthBody, resetBody, sessionIdParams, sessionsResponse,
  sessionStateResponse,
} from './auth.schemas.js';

const ALL_STAGES = ['mfa_verify', 'password_change', 'mfa_enroll', 'full'];

// Authentication API (A10). Routes about the signed-in user's own account
// declare `authenticated: true` (ADR-018); `stages` lists the steps of the
// login in which each one works.
export async function authRoutes(app, { services }) {
  const c = createAuthController(services);
  const route = (method, url, config, schema, handler) => app.route({ method, url, config, schema, handler });

  route('POST', '/api/v1/auth/login', { public: true },
    { body: loginBody, response: { 200: sessionStateResponse } }, c.login);
  route('POST', '/api/v1/auth/password/forgot', { public: true },
    { body: forgotBody, response: { 202: emptyResponse } }, c.passwordForgot);
  route('POST', '/api/v1/auth/password/reset', { public: true },
    { body: resetBody, response: { 200: emptyResponse } }, c.passwordReset);

  route('POST', '/api/v1/auth/logout', { authenticated: true, stages: ALL_STAGES },
    { response: { 200: emptyResponse } }, c.logout);
  route('GET', '/api/v1/auth/me', { authenticated: true, stages: ALL_STAGES },
    { response: { 200: sessionStateResponse } }, c.me);
  route('POST', '/api/v1/auth/mfa/verify', { authenticated: true, stages: ['mfa_verify'] },
    { body: mfaVerifyBody, response: { 200: sessionStateResponse } }, c.mfaVerify);
  route('POST', '/api/v1/auth/mfa/enroll/start', { authenticated: true, stages: ['mfa_enroll', 'full'] },
    { body: enrollStartBody, response: { 200: enrollStartResponse } }, c.enrollStart);
  route('POST', '/api/v1/auth/mfa/enroll/confirm', { authenticated: true, stages: ['mfa_enroll', 'full'] },
    { body: enrollConfirmBody, response: { 200: enrollConfirmResponse } }, c.enrollConfirm);
  route('POST', '/api/v1/auth/password/change', { authenticated: true, stages: ['password_change', 'full'] },
    { body: passwordChangeBody, response: { 200: sessionStateResponse } }, c.passwordChange);
  route('POST', '/api/v1/auth/reauth', { authenticated: true },
    { body: reauthBody, response: { 200: emptyResponse } }, c.reauth);
  route('GET', '/api/v1/auth/sessions', { authenticated: true },
    { response: { 200: sessionsResponse } }, c.listSessions);
  route('DELETE', '/api/v1/auth/sessions/:id', { authenticated: true },
    { params: sessionIdParams, response: { 200: emptyResponse } }, c.revokeSession);
}
