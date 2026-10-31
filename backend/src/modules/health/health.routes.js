import { createHealthController } from './health.controller.js';
import { liveResponse, readyResponse } from './health.schemas.js';
import { createHealthService } from './health.service.js';

export async function healthRoutes(app, { checks }) {
  const controller = createHealthController(createHealthService({ checks, logger: app.log }));

  app.get('/health/live', {
    config: { public: true },
    schema: { response: { 200: liveResponse } },
  }, controller.live);

  app.get('/health/ready', {
    config: { public: true },
    schema: { response: { 200: readyResponse } },
  }, controller.ready);
}
