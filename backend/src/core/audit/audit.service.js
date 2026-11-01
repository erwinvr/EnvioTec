// Audit service (A7). Every event goes through append_audit_log(), which
// chains it to the previous one by hash inside the database. Pass the
// transaction client when the action modifies data, so that the action fails
// if the audit fails; pass the pool for events that change nothing (a denied
// login, for example).

const MAX_USER_AGENT = 512;
const SENSITIVE_KEY = /password|token|secret|code|cookie|authorization|mfa_secret/i;

export function createAuditService() {
  return {
    async record(db, event) {
      const actor = event.actor ?? {};
      const actorType = actor.userId ? 'user' : (actor.type ?? 'anonymous');
      await db.query(
        'SELECT append_audit_log($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [
          actorType,
          actor.userId ?? null,
          actor.sessionHash ?? null,
          event.action,
          event.resourceType ?? null,
          event.resourceId === undefined || event.resourceId === null ? null : String(event.resourceId),
          event.result,
          event.context?.ip ?? null,
          event.context?.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
          event.context?.requestId ?? null,
          JSON.stringify(stripSensitive(event.metadata ?? {})),
        ],
      );
    },
  };
}

// Defense in depth: metadata never carries secrets even if a caller passes one.
export function stripSensitive(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !SENSITIVE_KEY.test(key)));
}

// Request data stored with each event. The IP is the one Fastify resolves
// through the trusted proxy only (A8).
export function auditContext(request) {
  return {
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: request.id,
  };
}

export function actorFrom(auth) {
  return auth ? { userId: auth.user.id, sessionHash: auth.sessionHash } : { type: 'anonymous' };
}
