import { createAuthController } from '../auth/auth.controller.js';
import { mfaResetResponse, userIdParams } from '../auth/auth.schemas.js';

// Users API. Phase 3 only adds the MFA reset (ADR-006); the rest of the
// module arrives in phase 5.
export async function usersRoutes(app, { services }) {
  const c = createAuthController(services);

  app.post('/api/v1/users/:id/mfa/reset', {
    config: { permission: 'users.reset_mfa' },
    schema: { params: userIdParams, response: { 200: mfaResetResponse } },
  }, c.mfaReset);
}
