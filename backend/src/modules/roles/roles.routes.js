import { createRolesController } from './roles.controller.js';
import { createRolesRepository } from './roles.repository.js';
import {
  createBody, emptyResponse, idParams, listResponse, permissionsBody, roleResponse, updateBody,
} from './roles.schemas.js';
import { createRolesService } from './roles.service.js';

export async function rolesRoutes(app, { db, audit }) {
  const c = createRolesController(createRolesService({ db, repository: createRolesRepository(), audit }));
  const route = (method, url, permission, schema, handler) => app.route({ method, url, config: { permission }, schema, handler });

  route('GET', '/api/v1/roles', 'roles.view', { response: { 200: listResponse } }, c.list);
  route('GET', '/api/v1/roles/:id', 'roles.view', { params: idParams, response: { 200: roleResponse } }, c.get);
  route('POST', '/api/v1/roles', 'roles.create', { body: createBody, response: { 201: roleResponse } }, c.create);
  route('PATCH', '/api/v1/roles/:id', 'roles.update', { params: idParams, body: updateBody, response: { 200: roleResponse } }, c.update);
  route('PUT', '/api/v1/roles/:id/permissions', 'roles.update',
    { params: idParams, body: permissionsBody, response: { 200: roleResponse } }, c.replacePermissions);
  route('DELETE', '/api/v1/roles/:id', 'roles.delete', { params: idParams, response: { 200: emptyResponse } }, c.remove);
}
