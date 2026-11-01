import { createAreasController } from './areas.controller.js';
import { createAreasRepository } from './areas.repository.js';
import { areaResponse, createBody, idParams, listResponse, updateBody } from './areas.schemas.js';
import { createAreasService } from './areas.service.js';

export async function areasRoutes(app, { db, audit }) {
  const c = createAreasController(createAreasService({ db, repository: createAreasRepository(), audit }));

  app.get('/api/v1/areas', {
    config: { authenticated: true },
    schema: { response: { 200: listResponse } },
  }, c.list);

  app.post('/api/v1/areas', {
    config: { permission: 'areas.manage' },
    schema: { body: createBody, response: { 201: areaResponse } },
  }, c.create);

  app.patch('/api/v1/areas/:id', {
    config: { permission: 'areas.manage' },
    schema: { params: idParams, body: updateBody, response: { 200: areaResponse } },
  }, c.update);
}
