import { createPermissionsController } from './permissions.controller.js';
import { createPermissionsRepository } from './permissions.repository.js';
import { listResponse } from './permissions.schemas.js';
import { createPermissionsService } from './permissions.service.js';

export async function permissionsRoutes(app, { db }) {
  const controller = createPermissionsController(createPermissionsService(createPermissionsRepository(db)));

  app.get('/api/v1/permissions', {
    config: { permission: 'permissions.view' },
    schema: { response: { 200: listResponse } },
  }, controller.list);
}
