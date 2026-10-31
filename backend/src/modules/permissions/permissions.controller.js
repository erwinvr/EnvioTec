import { ok } from '../../core/http/response.js';

export function createPermissionsController(service) {
  return {
    // The catalog is small and fixed (seeded), so it is returned whole.
    list: async () => {
      const permissions = await service.list();
      return ok(permissions, { total: permissions.length });
    },
  };
}
