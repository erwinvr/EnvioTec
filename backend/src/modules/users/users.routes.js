import { createAuthController } from '../auth/auth.controller.js';
import { mfaResetResponse, sessionsResponse } from '../auth/auth.schemas.js';
import { createUsersController } from './users.controller.js';
import { createUsersRepository } from './users.repository.js';
import { createUserRolesService } from './users.roles.service.js';
import {
  createBody, createResponse, idParams, listQuery, listResponse, passwordResponse, renewBody, reviewQuery,
  reviewResponse, revokeResponse, rolesBody, updateBody, userResponse,
} from './users.schemas.js';
import { createUsersService } from './users.service.js';

// Users API (A10). Local accounts are created here; AD accounts on their
// first login (Parte B), so users.create from the baseline is not used.
export async function usersRoutes(app, { db, audit, config, services }) {
  const repository = createUsersRepository();
  const c = createUsersController({
    users: createUsersService({ db, repository, audit, config }),
    roles: createUserRolesService({ db, repository, audit }),
  });
  const auth = createAuthController(services);
  const route = (method, url, permission, schema, handler) => app.route({ method, url, config: { permission }, schema, handler });
  const byId = (extra) => ({ params: idParams, ...extra });

  route('GET', '/api/v1/users', 'users.view', { querystring: listQuery, response: { 200: listResponse } }, c.list);
  route('GET', '/api/v1/users/review/local', 'users.view', { querystring: reviewQuery, response: { 200: reviewResponse } }, c.reviewLocal);
  route('GET', '/api/v1/users/:id', 'users.view', byId({ response: { 200: userResponse } }), c.get);
  route('POST', '/api/v1/users', 'users.create_local', { body: createBody, response: { 201: createResponse } }, c.create);
  route('PATCH', '/api/v1/users/:id', 'users.update', byId({ body: updateBody, response: { 200: userResponse } }), c.update);
  route('POST', '/api/v1/users/:id/disable', 'users.disable', byId({ response: { 200: userResponse } }), c.disable);
  route('POST', '/api/v1/users/:id/enable', 'users.disable', byId({ response: { 200: userResponse } }), c.enable);
  route('POST', '/api/v1/users/:id/unlock', 'users.unlock', byId({ response: { 200: userResponse } }), c.unlock);
  route('POST', '/api/v1/users/:id/reset-password', 'users.reset_password', byId({ response: { 200: passwordResponse } }), c.resetPassword);
  route('POST', '/api/v1/users/:id/renew', 'users.renew_local', byId({ body: renewBody, response: { 200: userResponse } }), c.renew);
  route('PUT', '/api/v1/users/:id/roles', 'roles.assign', byId({ body: rolesBody, response: { 200: userResponse } }), c.replaceRoles);
  route('GET', '/api/v1/users/:id/sessions', 'sessions.view_any', byId({ response: { 200: sessionsResponse } }), c.listSessions);
  route('DELETE', '/api/v1/users/:id/sessions', 'sessions.revoke_any', byId({ response: { 200: revokeResponse } }), c.revokeSessions);
  route('POST', '/api/v1/users/:id/mfa/reset', 'users.reset_mfa', byId({ response: { 200: mfaResetResponse } }), auth.mfaReset);
}
