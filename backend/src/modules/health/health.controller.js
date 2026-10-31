import { ServiceUnavailableError } from '../../core/errors/errors.js';
import { ok } from '../../core/http/response.js';

export function createHealthController(service) {
  return {
    live: async () => ok({ status: 'ok' }),

    // Does not reveal which dependency failed; that goes to the logs.
    ready: async () => {
      const { ready } = await service.readiness();
      if (!ready) throw new ServiceUnavailableError();
      return ok({ status: 'ready' });
    },
  };
}
