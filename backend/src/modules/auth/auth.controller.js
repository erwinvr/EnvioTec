import { auditContext } from '../../core/audit/audit.service.js';
import {
  clearedSessionCookie, hashToken, isWellFormedToken, readCookie, SESSION_COOKIE, sessionCookie,
} from '../../core/auth/session-token.js';
import { ok } from '../../core/http/response.js';

// HTTP <-> services. No business logic and no SQL here.

function setSession(reply, issued) {
  const maxAge = Math.max(0, Math.floor((new Date(issued.expiresAt).getTime() - Date.now()) / 1000));
  reply.header('set-cookie', sessionCookie(issued.token, maxAge));
}

function loginContext(request) {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  return { ...auditContext(request), currentSessionHash: isWellFormedToken(token) ? hashToken(token) : null };
}

export function createAuthController({ login, mfa, password, account, issuer }) {
  return {
    login: async (request, reply) => {
      const issued = await login.login(request.body, loginContext(request));
      setSession(reply, issued);
      return ok(await issuer.describe(issued.hash));
    },

    logout: async (request, reply) => {
      await account.logout(request.auth, auditContext(request));
      reply.header('set-cookie', clearedSessionCookie());
      return ok({});
    },

    me: async (request) => ok(await issuer.describe(request.auth.sessionHash)),

    mfaVerify: async (request, reply) => {
      const issued = await mfa.verify(request.auth, request.body, auditContext(request));
      setSession(reply, issued);
      return ok(await issuer.describe(issued.hash));
    },

    enrollStart: async (request) => ok(await mfa.enrollStart(request.auth, request.body ?? {}, auditContext(request))),

    enrollConfirm: async (request, reply) => {
      const { rotated, recoveryCodes } = await mfa.enrollConfirm(request.auth, request.body, auditContext(request));
      setSession(reply, rotated);
      return ok({ recoveryCodes, session: await issuer.describe(rotated.hash) });
    },

    passwordChange: async (request, reply) => {
      const issued = await password.change(request.auth, request.body, auditContext(request));
      setSession(reply, issued);
      return ok(await issuer.describe(issued.hash));
    },

    passwordForgot: async (request, reply) => {
      await password.forgot(request.body, auditContext(request));
      reply.code(202);
      return ok({});
    },

    passwordReset: async (request) => {
      await password.reset(request.body, auditContext(request));
      return ok({});
    },

    reauth: async (request) => {
      await account.reauthenticate(request.auth, request.body, auditContext(request));
      return ok({});
    },

    listSessions: async (request) => ok(await account.listSessions(request.auth)),

    revokeSession: async (request, reply) => {
      const { current } = await account.revokeSession(request.auth, request.params.id, auditContext(request));
      if (current) reply.header('set-cookie', clearedSessionCookie());
      return ok({});
    },

    mfaReset: async (request) => ok(await mfa.adminReset(request.auth, request.params.id, auditContext(request))),
  };
}
